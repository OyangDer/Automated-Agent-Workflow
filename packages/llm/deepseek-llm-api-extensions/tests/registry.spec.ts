import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import DeepSeekLlmApiExtensionRegistry from '../src/index.ts'

declare module '@deepseek-ai/dsh-deepseek-llm-api-extensions/types' {
  interface DeepSeekLlmApiExtensionMap {
    test_alpha: { readonly value: string }
    test_beta: readonly number[]
  }
}

const contexts: Context[] = []
const SIGNAL = new AbortController().signal

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function harness(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(DeepSeekLlmApiExtensionRegistry)
  return ctx
}

describe('DeepSeekLlmApiExtensionRegistry', () => {
  it('prepares detached fields and accepts every provider exactly once', async () => {
    const ctx = await harness()
    const first = vi.fn()
    const second = vi.fn()
    const mutable = { value: 'original' }
    ctx.deepseekLlmApiExtensions.register('test_alpha', {
      prepare: () => ({
        value: mutable,
        accept: first,
      }),
    })
    ctx.deepseekLlmApiExtensions.register('test_beta', {
      prepare: async request => ({
        value: [request.body.messages === undefined ? 0 : 1],
        accept: async () => { second() },
      }),
    })

    const prepared = await ctx.deepseekLlmApiExtensions.prepare({ body: { messages: [] }, signal: SIGNAL, sessionId: 's' })
    mutable.value = 'changed'
    expect(prepared.fields).toEqual({ test_alpha: { value: 'original' }, test_beta: [1] })
    expect(Object.isFrozen(prepared.fields)).toBe(true)
    expect(Object.isFrozen(prepared.fields.test_alpha)).toBe(true)

    await Promise.all([prepared.accept(), prepared.accept()])
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('preserves the prepared result as an acceptance method receiver', async () => {
    const ctx = await harness()
    const result = {
      value: { value: 'receiver' },
      accepted: 0,
      accept(): void {
        this.accepted += 1
      },
    }
    ctx.deepseekLlmApiExtensions.register('test_alpha', { prepare: () => result })

    const prepared = await ctx.deepseekLlmApiExtensions.prepare({ body: {}, signal: SIGNAL })
    await prepared.accept()
    expect(result.accepted).toBe(1)
  })

  it('rejects duplicate fields and releases ownership with the registering fiber', async () => {
    const ctx = await harness()
    const owner = ctx.extend()
    const dispose = owner.deepseekLlmApiExtensions.register('test_alpha', {
      prepare: () => ({ value: { value: 'one' } }),
    })
    expect(() => ctx.deepseekLlmApiExtensions.register('test_alpha', {
      prepare: () => ({ value: { value: 'two' } }),
    })).toThrow(/already registered/)

    await dispose()
    ctx.deepseekLlmApiExtensions.register('test_alpha', {
      prepare: () => ({ value: { value: 'replacement' } }),
    })
    await expect(ctx.deepseekLlmApiExtensions.prepare({ body: {}, signal: SIGNAL }))
      .resolves.toMatchObject({ fields: { test_alpha: { value: 'replacement' } } })
  })

  it('settles every acceptance callback before reporting one or several failures', async () => {
    const ctx = await harness()
    const later = vi.fn()
    ctx.deepseekLlmApiExtensions.register('test_alpha', {
      prepare: () => ({
        value: { value: 'x' },
        accept: () => { throw new Error('alpha failed') },
      }),
    })
    ctx.deepseekLlmApiExtensions.register('test_beta', {
      prepare: () => ({
        value: [2],
        accept: () => { later(); throw new Error('beta failed') },
      }),
    })
    const prepared = await ctx.deepseekLlmApiExtensions.prepare({ body: {}, signal: SIGNAL })
    await expect(prepared.accept()).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: 'alpha failed' }), expect.objectContaining({ message: 'beta failed' })],
    })
    expect(later).toHaveBeenCalledOnce()
  })

  it('reports a single acceptance failure verbatim and omits an undefined contribution', async () => {
    const ctx = await harness()
    const failure = new Error('single failure')
    ctx.deepseekLlmApiExtensions.register('test_alpha', {
      prepare: () => ({ value: { value: 'x' }, accept: () => { throw failure } }),
    })
    ctx.deepseekLlmApiExtensions.register('test_beta', { prepare: () => undefined })
    const prepared = await ctx.deepseekLlmApiExtensions.prepare({ body: {}, signal: SIGNAL })
    expect(prepared.fields).toEqual({ test_alpha: { value: 'x' } })
    await expect(prepared.accept()).rejects.toBe(failure)
  })

  it('rejects invalid field names and preparation failures before returning fields', async () => {
    const ctx = await harness()
    expect(() => ctx.deepseekLlmApiExtensions.register('' as 'test_alpha', {
      prepare: () => ({ value: { value: 'x' } }),
    })).toThrow(/non-blank trimmed/)
    ctx.deepseekLlmApiExtensions.register('test_alpha', {
      prepare: () => { throw new Error('prepare failed') },
    })
    await expect(ctx.deepseekLlmApiExtensions.prepare({ body: {}, signal: SIGNAL })).rejects.toThrow('prepare failed')
  })

  it('degrades an optional preparation failure to a warning while the remaining fields proceed', async () => {
    const ctx = await harness()
    const warnings: string[] = []
    ctx.logger.warn = ((message: string) => void warnings.push(message)) as typeof ctx.logger.warn
    ctx.deepseekLlmApiExtensions.register('test_alpha', {
      prepare: () => { throw new Error('manifest missing') },
    }, { optional: true })
    ctx.deepseekLlmApiExtensions.register('test_beta', { prepare: () => ({ value: [3] }) })

    const prepared = await ctx.deepseekLlmApiExtensions.prepare({ body: {}, signal: SIGNAL })
    expect(prepared.fields).toEqual({ test_beta: [3] })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('optional field "test_alpha"')
    expect(warnings[0]).toContain('manifest missing')
    await prepared.accept()
  })

  it('keeps a required preparation failure fatal beside an optional field', async () => {
    const ctx = await harness()
    const warnings: string[] = []
    ctx.logger.warn = ((message: string) => void warnings.push(message)) as typeof ctx.logger.warn
    ctx.deepseekLlmApiExtensions.register('test_alpha', {
      prepare: () => ({ value: { value: 'kept' } }),
    }, { optional: true })
    ctx.deepseekLlmApiExtensions.register('test_beta', {
      prepare: () => { throw new Error('core field unavailable') },
    })

    await expect(ctx.deepseekLlmApiExtensions.prepare({ body: {}, signal: SIGNAL }))
      .rejects.toThrow('core field unavailable')
    expect(warnings).toEqual([])
  })

  it('renders a non-Error optional failure and resumes the field on the next request', async () => {
    const ctx = await harness()
    const warnings: string[] = []
    ctx.logger.warn = ((message: string) => void warnings.push(message)) as typeof ctx.logger.warn
    let broken = true
    ctx.deepseekLlmApiExtensions.register('test_alpha', {
      prepare: () => {
        if (broken) throw 'plain failure'
        return { value: { value: 'recovered' } }
      },
    }, { optional: true })

    expect((await ctx.deepseekLlmApiExtensions.prepare({ body: {}, signal: SIGNAL })).fields).toEqual({})
    broken = false
    expect((await ctx.deepseekLlmApiExtensions.prepare({ body: {}, signal: SIGNAL })).fields)
      .toEqual({ test_alpha: { value: 'recovered' } })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('plain failure')
  })

  it('never degrades request cancellation into an optional warning', async () => {
    const ctx = await harness()
    const warnings: string[] = []
    ctx.logger.warn = ((message: string) => void warnings.push(message)) as typeof ctx.logger.warn
    const controller = new AbortController()
    const started = Promise.withResolvers<undefined>()
    ctx.deepseekLlmApiExtensions.register('test_alpha', {
      prepare: request => new Promise((_resolve, reject) => {
        started.resolve(undefined)
        request.signal.addEventListener('abort', () => { reject(new Error('provider observed abort')) }, { once: true })
      }),
    }, { optional: true })

    const pending = ctx.deepseekLlmApiExtensions.prepare({ body: {}, signal: controller.signal })
    await started.promise
    controller.abort(new Error('cancelled during optional preparation'))
    await expect(pending).rejects.toBe(controller.signal.reason)
    expect(warnings).toEqual([])
  }, 500)

  it('stops waiting for a provider that ignores request cancellation', async () => {
    const ctx = await harness()
    const controller = new AbortController()
    const started = Promise.withResolvers<undefined>()
    ctx.deepseekLlmApiExtensions.register('test_alpha', {
      prepare: () => {
        started.resolve(undefined)
        return new Promise(() => {})
      },
    })

    const pending = ctx.deepseekLlmApiExtensions.prepare({
      body: {},
      signal: controller.signal,
    })
    await started.promise
    controller.abort(new Error('cancelled during extension preparation'))
    await expect(pending).rejects.toBe(controller.signal.reason)
  }, 500)
})

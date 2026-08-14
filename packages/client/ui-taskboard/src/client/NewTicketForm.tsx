/**
 * NewTicketForm: the create overlay. A new ticket always lands in Backlog;
 * the user picks title, description, priority, and ordering dependencies.
 */
import { useState } from 'react'
import type {
  CreateTicketRequest, Priority, TicketView,
} from '@deepseek-ai/dsh-taskboard/client'
import type { TaskboardT } from './TicketCard.tsx'
import css from './NewTicketForm.module.css'

const PRIORITIES: readonly Priority[] = ['low', 'normal', 'high']

export interface NewTicketFormProps {
  board: TicketView[]
  t: TaskboardT
  onSubmit: (request: CreateTicketRequest) => Promise<void>
  onCancel: () => void
}

export function NewTicketForm({ board, t, onSubmit, onCancel }: NewTicketFormProps) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState<Priority>('normal')
  const [dependsOn, setDependsOn] = useState<string[]>([])
  const [pending, setPending] = useState(false)

  const submit = async (): Promise<void> => {
    if (title.trim() === '') return
    setPending(true)
    try {
      await onSubmit({ title, description, priority, dependsOn })
    } finally {
      setPending(false)
    }
  }

  return (
    <div className={css.overlay} role="dialog" aria-label={t('action.new')}>
      <div className={css.dialog}>
        <header className={css.header}>
          <h2 className={css.title}>{t('action.new')}</h2>
        </header>
        <div className={css.body}>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('form.title')}</span>
            <input className={css.input} value={title} onChange={event => setTitle(event.target.value)} autoFocus />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('form.description')}</span>
            <textarea className={css.textarea} value={description} onChange={event => setDescription(event.target.value)} />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('form.priority')}</span>
            <select className={css.input} value={priority} onChange={event => setPriority(event.target.value as Priority)}>
              {PRIORITIES.map(value => (
                <option key={value} value={value}>{t(('priority.' + value) as never)}</option>
              ))}
            </select>
          </label>
          <div className={css.field}>
            <span className={css.fieldLabel}>{t('form.dependsOn')}</span>
            <div className={css.dependencyPicker}>
              {board.filter(candidate => candidate.column !== 'done').map(candidate => (
                <label key={candidate.id} className={css.dependencyOption}>
                  <input
                    type="checkbox"
                    checked={dependsOn.includes(candidate.id)}
                    onChange={(event) => {
                      setDependsOn(current => event.target.checked
                        ? [...current, candidate.id]
                        : current.filter(id => id !== candidate.id))
                    }}
                  />
                  <span>{candidate.title}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
        <footer className={css.footer}>
          <button
            type="button"
            className={css.buttonPrimary}
            disabled={pending || title.trim() === ''}
            onClick={() => { void submit() }}
          >
            {t('action.save')}
          </button>
          <button type="button" className={css.button} onClick={onCancel}>{t('action.cancel')}</button>
        </footer>
      </div>
    </div>
  )
}

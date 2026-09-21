window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-taskboard",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let _deepseek_ai_dsh_client_store = require("@deepseek-ai/dsh-client-store");
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		//#region lib/types/client/stores.js
		/**
		* The taskboard tab's viewing store: which card's detail panel is open.
		* Module level exports the factory only (a module-level handle would pin the
		* store identity across plugin reloads); register() receives the factory and
		* the component derives its PropsStore share from the return type.
		*/
		/**
		* Create the taskboard viewing store handle.
		* @returns the store handle (spec + type + identity + factory in one).
		*/
		function createTaskboardStore() {
			return (0, _deepseek_ai_dsh_client_store.defineStore)({
				init: () => ({ selectedId: null }),
				actions: { select: (d, id) => {
					d.selectedId = id;
				} }
			});
		}
		//#endregion
		//#region lib/types/client/dragScroll.js
		/**
		* Pure drag-and-drop helpers for the kanban board: edge auto-scroll math and
		* insertion-slot resolution. Kept dependency-free so the rules are
		* unit-testable without a DOM; the view only measures rects and applies the
		* returned deltas.
		*/
		/** Defaults; the board view accepts overrides through its dragAutoScroll prop. */
		const DRAG_AUTO_SCROLL_DEFAULTS = {
			threshold: 48,
			speed: 12
		};
		/**
		* Signed per-frame scroll delta along one axis for a pointer at `client`
		* over a container spanning [start, start + size]. Negative scrolls up/left,
		* positive scrolls down/right, 0 keeps the position. Speed ramps linearly
		* from 1 to `speed` as the pointer approaches the container edge; a tiny
		* container halves the zone so the two edges never swallow the middle.
		* @param client - the pointer coordinate on this axis (clientX/clientY).
		* @param start - the container's leading edge on this axis.
		* @param size - the container's extent on this axis.
		* @param threshold - the edge zone width that arms auto-scroll.
		* @param speed - the maximum pixels per frame at the very edge.
		* @returns the signed per-frame delta to add to scrollTop/scrollLeft.
		*/
		function autoScrollDelta(client, start, size, threshold, speed) {
			if (size <= 0 || threshold <= 0 || speed <= 0) return 0;
			const zone = Math.min(threshold, size / 2);
			const topZoneEnd = start + zone;
			const bottomZoneStart = start + size - zone;
			if (client < topZoneEnd) {
				const depth = Math.min(1, (topZoneEnd - client) / zone);
				return -Math.max(1, Math.round(speed * depth));
			}
			if (client > bottomZoneStart) {
				const depth = Math.min(1, (client - bottomZoneStart) / zone);
				return Math.max(1, Math.round(speed * depth));
			}
			return 0;
		}
		/**
		* The card-list slot a pointer at `clientY` lands in: the index of the
		* first card whose vertical midpoint sits below the pointer, else the end of
		* the list. Cards are assumed ordered top-to-bottom as rendered, so the
		* result is the insertion index (0..spans.length).
		* @param clientY - the pointer's vertical coordinate.
		* @param spans - each card's vertical span, in render order.
		* @returns the index to insert before; spans.length appends at the end.
		*/
		function insertionIndexAt(clientY, spans) {
			for (let i = 0; i < spans.length; i++) {
				const span = spans[i];
				if (span !== void 0 && clientY < span.top + (span.bottom - span.top) / 2) return i;
			}
			return spans.length;
		}
		/**
		* Resolve a drop target's beforeTicketId into a card-list slot: the index of
		* the card to insert before, or ids.length to append at the end.
		* @param ticketIds - the column's ticket ids in render order.
		* @param beforeTicketId - the ticket to insert before, or null to append.
		* @returns the insertion slot in [0, ticketIds.length].
		*/
		function insertionSlot(ticketIds, beforeTicketId) {
			if (beforeTicketId === null) return ticketIds.length;
			const index = ticketIds.indexOf(beforeTicketId);
			return index === -1 ? ticketIds.length : index;
		}
		//#endregion
		//#region \0dsh-css:C:\Users\O'yan'd'D'er\deepseek-harness\packages\client\ui-taskboard\src\client\TicketCard.module.css.mjs
		const css$3 = ".LILZya_card{background:var(--dsw-alias-bg-module-platform);border:.5px solid var(--dsw-alias-border-l2);border-left:3px solid var(--taskboard-card-accent,var(--dsw-alias-brand-primary));cursor:grab;border-radius:8px;flex-direction:column;gap:6px;padding:8px 10px;display:flex}.LILZya_card:hover{border-color:var(--dsw-alias-interactive-bg-hover-solid)}.LILZya_cardSelected{border-color:var(--dsw-alias-brand-primary);box-shadow:var(--dsw-shadow-lv3)}.LILZya_cardDragging{opacity:.5}.LILZya_cardTop{justify-content:space-between;align-items:center;gap:8px;display:flex}.LILZya_cardTopLeft{align-items:center;gap:6px;min-width:0;display:flex}.LILZya_priority{color:var(--taskboard-card-accent,var(--dsw-alias-label-secondary));border:1px solid;border-radius:4px;padding:0 4px;font-size:11px;line-height:16px}.LILZya_typeBadge{color:var(--taskboard-card-type-accent,var(--dsw-alias-label-secondary));border:1px solid;border-radius:4px;padding:0 4px;font-size:11px;line-height:16px}.LILZya_id{font-family:var(--dsw-font-mono);color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;font-size:10px;line-height:14px;overflow:hidden}.LILZya_cardTitle{color:var(--dsw-alias-label-primary);word-break:break-word;margin:0;font-size:13px;line-height:18px}.LILZya_cardDescription{color:var(--dsw-alias-label-secondary);-webkit-line-clamp:3;-webkit-box-orient:vertical;margin:0;font-size:12px;line-height:16px;display:-webkit-box;overflow:hidden}.LILZya_cardMeta{flex-wrap:wrap;align-items:center;gap:6px;display:flex}.LILZya_metaLabel{color:var(--dsw-alias-label-dimmed);font-size:11px;line-height:16px}.LILZya_badge{border-radius:4px;padding:0 4px;font-size:11px;line-height:16px}.LILZya_badgeReviewing{color:var(--dsw-alias-state-warn-label);background:var(--dsw-alias-state-warn-tertiary)}.LILZya_badgeRejected{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-state-error-secondary)}.LILZya_badgeApproved{color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-tertiary)}.LILZya_badgePaused{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-module-secondary)}";
		const tagId$3 = "@deepseek-ai/dsh-client-ui-taskboard/TicketCard.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$3) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-taskboard";
			tag.dataset.pluginCss = tagId$3;
			tag.textContent = css$3;
			document.head.appendChild(tag);
		}
		var TicketCard_module_css_default = {
			"badge": "LILZya_badge",
			"badgeApproved": "LILZya_badgeApproved",
			"badgePaused": "LILZya_badgePaused",
			"badgeRejected": "LILZya_badgeRejected",
			"badgeReviewing": "LILZya_badgeReviewing",
			"card": "LILZya_card",
			"cardDescription": "LILZya_cardDescription",
			"cardDragging": "LILZya_cardDragging",
			"cardMeta": "LILZya_cardMeta",
			"cardSelected": "LILZya_cardSelected",
			"cardTitle": "LILZya_cardTitle",
			"cardTop": "LILZya_cardTop",
			"cardTopLeft": "LILZya_cardTopLeft",
			"id": "LILZya_id",
			"metaLabel": "LILZya_metaLabel",
			"priority": "LILZya_priority",
			"typeBadge": "LILZya_typeBadge"
		};
		//#endregion
		//#region lib/types/client/TicketCard.js
		/** Priority → accent token (local custom property consumed by the CSS). */
		const PRIORITY_ACCENT = {
			low: "var(--dsw-alias-label-tertiary)",
			normal: "var(--dsw-alias-state-business-primary)",
			high: "var(--dsw-alias-state-error-primary)"
		};
		/** Ticket type → accent token for the kind badge (remaining kinds fall back). */
		const TYPE_ACCENT = {
			feature: "var(--dsw-alias-state-business-primary)",
			bugfix: "var(--dsw-alias-state-error-primary)",
			test: "var(--dsw-alias-state-warn-primary)",
			merge: "var(--dsw-alias-state-success-primary)"
		};
		/** The type accent with a neutral fallback for the remaining kinds. */
		function typeAccent(type) {
			return TYPE_ACCENT[type] ?? "var(--dsw-alias-label-tertiary)";
		}
		function TicketCard({ ticket, selected, dragging, t, onSelect, onDragStart, onDragEnd }) {
			const rejected = ticket.lastReview?.outcome === "rejected";
			const reviewing = ticket.column === "in_testing";
			const approved = ticket.lastReview?.outcome === "approved";
			const paused = ticket.status === "paused";
			return (0, react_jsx_runtime.jsxs)("article", {
				className: TicketCard_module_css_default.card + (selected ? " " + TicketCard_module_css_default.cardSelected : "") + (dragging ? " " + TicketCard_module_css_default.cardDragging : ""),
				draggable: true,
				"data-ticket-id": ticket.id,
				style: {
					"--taskboard-card-accent": PRIORITY_ACCENT[ticket.priority],
					"--taskboard-card-type-accent": typeAccent(ticket.type)
				},
				onClick: onSelect,
				onDragStart: (event) => {
					event.dataTransfer.setData("text/plain", ticket.id);
					event.dataTransfer.effectAllowed = "move";
					onDragStart();
				},
				onDragEnd,
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						className: TicketCard_module_css_default.cardTop,
						children: [(0, react_jsx_runtime.jsxs)("span", {
							className: TicketCard_module_css_default.cardTopLeft,
							children: [(0, react_jsx_runtime.jsx)("span", {
								className: TicketCard_module_css_default.priority,
								title: t("priority." + ticket.priority),
								children: t("priority." + ticket.priority)
							}), (0, react_jsx_runtime.jsx)("span", {
								className: TicketCard_module_css_default.typeBadge,
								title: t("type." + ticket.type),
								children: t("type." + ticket.type)
							})]
						}), (0, react_jsx_runtime.jsx)("span", {
							className: TicketCard_module_css_default.id,
							children: ticket.id
						})]
					}),
					(0, react_jsx_runtime.jsx)("h2", {
						className: TicketCard_module_css_default.cardTitle,
						children: ticket.title
					}),
					ticket.description.trim() !== "" && (0, react_jsx_runtime.jsx)("p", {
						className: TicketCard_module_css_default.cardDescription,
						children: ticket.description
					}),
					(0, react_jsx_runtime.jsxs)("div", {
						className: TicketCard_module_css_default.cardMeta,
						children: [
							ticket.assignee === null ? (0, react_jsx_runtime.jsx)("span", {
								className: TicketCard_module_css_default.metaLabel,
								children: t("state.unassigned")
							}) : (0, react_jsx_runtime.jsx)("span", {
								className: TicketCard_module_css_default.metaLabel,
								children: ticket.assignee.label
							}),
							reviewing && (0, react_jsx_runtime.jsx)("span", {
								className: TicketCard_module_css_default.badge + " " + TicketCard_module_css_default.badgeReviewing,
								children: t("state.reviewing")
							}),
							rejected && (0, react_jsx_runtime.jsx)("span", {
								className: TicketCard_module_css_default.badge + " " + TicketCard_module_css_default.badgeRejected,
								children: t("state.rejected")
							}),
							approved && (0, react_jsx_runtime.jsx)("span", {
								className: TicketCard_module_css_default.badge + " " + TicketCard_module_css_default.badgeApproved,
								children: t("state.approved")
							}),
							paused && (0, react_jsx_runtime.jsx)("span", {
								className: TicketCard_module_css_default.badge + " " + TicketCard_module_css_default.badgePaused,
								children: t("state.paused")
							}),
							ticket.reviewAttempts > 0 && (0, react_jsx_runtime.jsx)("span", {
								className: TicketCard_module_css_default.metaLabel,
								children: t("state.attempts").replace("{count}", String(ticket.reviewAttempts))
							})
						]
					})
				]
			});
		}
		//#endregion
		//#region \0dsh-css:C:\Users\O'yan'd'D'er\deepseek-harness\packages\client\ui-taskboard\src\client\TicketDetail.module.css.mjs
		const css$2 = ".fe8_nW_panel{background:var(--dsw-alias-bg-module-platform);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);width:360px;max-width:90%;box-shadow:var(--dsw-shadow-lv3);border-left:0;flex-direction:column;display:flex;position:absolute;inset:0 0 0 auto}.fe8_nW_header{border-bottom:.5px solid var(--dsw-alias-border-l2);justify-content:space-between;align-items:center;gap:8px;padding:10px 12px;display:flex}.fe8_nW_title{color:var(--dsw-alias-label-primary);word-break:break-word;margin:0;font-size:14px;line-height:20px}.fe8_nW_closeButton{color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0 4px;font-size:18px;line-height:20px}.fe8_nW_closeButton:hover{color:var(--dsw-alias-label-primary)}.fe8_nW_body{flex-direction:column;flex:1;gap:12px;padding:12px;display:flex;overflow-y:auto}.fe8_nW_facts{grid-template-columns:1fr 1fr;gap:6px 12px;margin:0;display:grid}.fe8_nW_fact{flex-direction:column;gap:2px;display:flex}.fe8_nW_fact dt{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}.fe8_nW_fact dd{color:var(--dsw-alias-label-secondary);word-break:break-all;margin:0;font-size:12px;line-height:16px}.fe8_nW_description{color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;margin:0;font-size:13px;line-height:20px}.fe8_nW_section{flex-direction:column;gap:4px;display:flex}.fe8_nW_sectionTitle{color:var(--dsw-alias-label-secondary);margin:0;font-size:12px;line-height:16px}.fe8_nW_paragraph{color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;margin:0;font-size:12px;line-height:18px}.fe8_nW_dependencyList{margin:0;padding-left:18px}.fe8_nW_dependency{font-family:var(--dsw-font-mono);color:var(--dsw-alias-label-dimmed);font-size:11px;line-height:16px}.fe8_nW_reviewBox{border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;flex-direction:column;gap:4px;padding:8px 10px;display:flex}.fe8_nW_reviewRejected{border-color:var(--dsw-alias-state-error-primary)}.fe8_nW_reviewApproved{border-color:var(--dsw-alias-state-success-primary)}.fe8_nW_reviewMeta{color:var(--dsw-alias-label-tertiary);margin:0;font-size:11px;line-height:16px}.fe8_nW_historyList{flex-direction:column;gap:4px;margin:0;padding:0;list-style:none;display:flex}.fe8_nW_historyRow{justify-content:space-between;align-items:baseline;gap:8px;display:flex}.fe8_nW_historyDetail{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:16px}.fe8_nW_historyTime{color:var(--dsw-alias-label-tertiary);white-space:nowrap;font-size:10px;line-height:14px}.fe8_nW_editForm{flex-direction:column;gap:10px;display:flex}.fe8_nW_field{flex-direction:column;gap:4px;display:flex}.fe8_nW_fieldLabel{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}.fe8_nW_input,.fe8_nW_textarea{background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);border-radius:6px;padding:6px 8px;font-size:12px;line-height:18px}.fe8_nW_textarea{resize:vertical;min-height:80px}.fe8_nW_dependencyPicker{flex-direction:column;gap:4px;max-height:140px;display:flex;overflow-y:auto}.fe8_nW_dependencyOption{color:var(--dsw-alias-label-secondary);align-items:center;gap:6px;font-size:12px;line-height:16px;display:flex}.fe8_nW_footer{border-top:.5px solid var(--dsw-alias-border-l2);flex-wrap:wrap;gap:6px;padding:10px 12px;display:flex}.fe8_nW_button{background:var(--dsw-alias-button-tool-bar-fill);border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);cursor:pointer;border-radius:6px;padding:4px 10px;font-size:12px;line-height:18px}.fe8_nW_button:hover{background:var(--dsw-alias-button-tool-bar-hover)}.fe8_nW_buttonPrimary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted);cursor:pointer;border:1px solid #0000;border-radius:6px;padding:4px 10px;font-size:12px;line-height:18px}.fe8_nW_buttonPrimary:hover{background:var(--dsw-alias-button-primary-hover)}.fe8_nW_buttonDanger{background:var(--dsw-alias-interactive-bg-hover-danger);border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);cursor:pointer;border-radius:6px;padding:4px 10px;font-size:12px;line-height:18px}.fe8_nW_button:disabled,.fe8_nW_buttonPrimary:disabled,.fe8_nW_buttonDanger:disabled{opacity:.6;cursor:default}";
		const tagId$2 = "@deepseek-ai/dsh-client-ui-taskboard/TicketDetail.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$2) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-taskboard";
			tag.dataset.pluginCss = tagId$2;
			tag.textContent = css$2;
			document.head.appendChild(tag);
		}
		var TicketDetail_module_css_default = {
			"body": "fe8_nW_body",
			"button": "fe8_nW_button",
			"buttonDanger": "fe8_nW_buttonDanger",
			"buttonPrimary": "fe8_nW_buttonPrimary",
			"closeButton": "fe8_nW_closeButton",
			"dependency": "fe8_nW_dependency",
			"dependencyList": "fe8_nW_dependencyList",
			"dependencyOption": "fe8_nW_dependencyOption",
			"dependencyPicker": "fe8_nW_dependencyPicker",
			"description": "fe8_nW_description",
			"editForm": "fe8_nW_editForm",
			"fact": "fe8_nW_fact",
			"facts": "fe8_nW_facts",
			"field": "fe8_nW_field",
			"fieldLabel": "fe8_nW_fieldLabel",
			"footer": "fe8_nW_footer",
			"header": "fe8_nW_header",
			"historyDetail": "fe8_nW_historyDetail",
			"historyList": "fe8_nW_historyList",
			"historyRow": "fe8_nW_historyRow",
			"historyTime": "fe8_nW_historyTime",
			"input": "fe8_nW_input",
			"panel": "fe8_nW_panel",
			"paragraph": "fe8_nW_paragraph",
			"reviewApproved": "fe8_nW_reviewApproved",
			"reviewBox": "fe8_nW_reviewBox",
			"reviewMeta": "fe8_nW_reviewMeta",
			"reviewRejected": "fe8_nW_reviewRejected",
			"section": "fe8_nW_section",
			"sectionTitle": "fe8_nW_sectionTitle",
			"textarea": "fe8_nW_textarea",
			"title": "fe8_nW_title"
		};
		//#endregion
		//#region lib/types/client/TicketDetail.js
		/**
		* TicketDetail: the read/edit overlay for one selected card. Shows the full
		* ticket, review state and history, and offers the user-side verbs: edit,
		* adjacent-column moves, re-review, and a two-step delete.
		*/
		/** The five workflow columns in canonical left-to-right order. */
		const COLUMNS$1 = [
			"backlog",
			"not_started",
			"in_progress",
			"in_testing",
			"done"
		];
		const PRIORITIES$1 = [
			"low",
			"normal",
			"high"
		];
		/**
		* Turn one rejected verb into a user-facing message: surface the real
		* server failure text when the rejection carries one, falling back to the
		* generic copy for non-Error rejections.
		*/
		function failureMessage(error, fallback) {
			return error instanceof Error && error.message.trim() !== "" ? error.message : fallback;
		}
		function TicketDetail({ ticket, board, t, onClose, onEdit, onRemove, onRequestReview, onMove, onError }) {
			const [editing, setEditing] = (0, react.useState)(false);
			const [armDelete, setArmDelete] = (0, react.useState)(false);
			const [title, setTitle] = (0, react.useState)(ticket.title);
			const [description, setDescription] = (0, react.useState)(ticket.description);
			const [priority, setPriority] = (0, react.useState)(ticket.priority);
			const [dependsOn, setDependsOn] = (0, react.useState)(ticket.dependsOn);
			const [filesScope, setFilesScope] = (0, react.useState)(ticket.filesScope);
			const [pending, setPending] = (0, react.useState)(false);
			const columnIndex = COLUMNS$1.indexOf(ticket.column);
			const prevColumn = columnIndex > 0 ? COLUMNS$1[columnIndex - 1] ?? null : null;
			const nextColumn = columnIndex >= 0 && columnIndex < COLUMNS$1.length - 1 ? COLUMNS$1[columnIndex + 1] ?? null : null;
			const save = async () => {
				if (title.trim() === "") {
					onError(t("error.generic"));
					return;
				}
				setPending(true);
				try {
					await onEdit({
						ticketId: ticket.id,
						boardId: ticket.boardId,
						title,
						description,
						priority,
						dependsOn,
						filesScope
					});
					setEditing(false);
				} catch (error) {
					onError(failureMessage(error, t("error.generic")));
				} finally {
					setPending(false);
				}
			};
			const remove = async () => {
				if (!armDelete) {
					setArmDelete(true);
					return;
				}
				setPending(true);
				try {
					await onRemove({
						ticketId: ticket.id,
						boardId: ticket.boardId
					});
					onClose();
				} catch (error) {
					onError(failureMessage(error, t("error.generic")));
				} finally {
					setPending(false);
				}
			};
			const requestReview = async () => {
				setPending(true);
				try {
					await onRequestReview({
						ticketId: ticket.id,
						boardId: ticket.boardId
					});
				} catch (error) {
					onError(failureMessage(error, t("error.generic")));
				} finally {
					setPending(false);
				}
			};
			const lastReview = ticket.lastReview;
			return (0, react_jsx_runtime.jsxs)("aside", {
				className: TicketDetail_module_css_default.panel,
				role: "dialog",
				"aria-label": ticket.title,
				children: [
					(0, react_jsx_runtime.jsxs)("header", {
						className: TicketDetail_module_css_default.header,
						children: [(0, react_jsx_runtime.jsx)("h2", {
							className: TicketDetail_module_css_default.title,
							children: ticket.title
						}), (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: TicketDetail_module_css_default.closeButton,
							onClick: onClose,
							"aria-label": t("action.close"),
							children: "×"
						})]
					}),
					(0, react_jsx_runtime.jsxs)("div", {
						className: TicketDetail_module_css_default.body,
						children: [
							(0, react_jsx_runtime.jsxs)("dl", {
								className: TicketDetail_module_css_default.facts,
								children: [
									(0, react_jsx_runtime.jsxs)("div", {
										className: TicketDetail_module_css_default.fact,
										children: [(0, react_jsx_runtime.jsx)("dt", { children: t("detail.assignee") }), (0, react_jsx_runtime.jsx)("dd", { children: ticket.assignee === null ? t("state.unassigned") : ticket.assignee.label })]
									}),
									(0, react_jsx_runtime.jsxs)("div", {
										className: TicketDetail_module_css_default.fact,
										children: [(0, react_jsx_runtime.jsx)("dt", { children: t("detail.reviewer") }), (0, react_jsx_runtime.jsx)("dd", { children: ticket.reviewer === null ? t("state.unassigned") : ticket.reviewer.label })]
									}),
									(0, react_jsx_runtime.jsxs)("div", {
										className: TicketDetail_module_css_default.fact,
										children: [(0, react_jsx_runtime.jsx)("dt", { children: t("detail.reviewAttempts") }), (0, react_jsx_runtime.jsx)("dd", { children: String(ticket.reviewAttempts) })]
									}),
									(0, react_jsx_runtime.jsxs)("div", {
										className: TicketDetail_module_css_default.fact,
										children: [(0, react_jsx_runtime.jsx)("dt", { children: t("form.priority") }), (0, react_jsx_runtime.jsx)("dd", { children: t("priority." + ticket.priority) })]
									}),
									(0, react_jsx_runtime.jsxs)("div", {
										className: TicketDetail_module_css_default.fact,
										children: [(0, react_jsx_runtime.jsx)("dt", { children: t("detail.filesScope") }), (0, react_jsx_runtime.jsx)("dd", { children: ticket.filesScope.trim() === "" ? "—" : ticket.filesScope })]
									})
								]
							}),
							!editing && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
								(0, react_jsx_runtime.jsx)("p", {
									className: TicketDetail_module_css_default.description,
									children: ticket.description.trim() === "" ? "—" : ticket.description
								}),
								ticket.devNotes.trim() !== "" && (0, react_jsx_runtime.jsxs)("section", {
									className: TicketDetail_module_css_default.section,
									children: [(0, react_jsx_runtime.jsx)("h3", {
										className: TicketDetail_module_css_default.sectionTitle,
										children: t("detail.devNotes")
									}), (0, react_jsx_runtime.jsx)("p", {
										className: TicketDetail_module_css_default.paragraph,
										children: ticket.devNotes
									})]
								}),
								ticket.dependsOn.length > 0 && (0, react_jsx_runtime.jsxs)("section", {
									className: TicketDetail_module_css_default.section,
									children: [(0, react_jsx_runtime.jsx)("h3", {
										className: TicketDetail_module_css_default.sectionTitle,
										children: t("form.dependsOn")
									}), (0, react_jsx_runtime.jsx)("ul", {
										className: TicketDetail_module_css_default.dependencyList,
										children: ticket.dependsOn.map((id) => (0, react_jsx_runtime.jsx)("li", {
											className: TicketDetail_module_css_default.dependency,
											children: id
										}, id))
									})]
								})
							] }),
							editing && (0, react_jsx_runtime.jsxs)("div", {
								className: TicketDetail_module_css_default.editForm,
								children: [
									(0, react_jsx_runtime.jsxs)("label", {
										className: TicketDetail_module_css_default.field,
										children: [(0, react_jsx_runtime.jsx)("span", {
											className: TicketDetail_module_css_default.fieldLabel,
											children: t("form.title")
										}), (0, react_jsx_runtime.jsx)("input", {
											className: TicketDetail_module_css_default.input,
											value: title,
											onChange: (event) => setTitle(event.target.value)
										})]
									}),
									(0, react_jsx_runtime.jsxs)("label", {
										className: TicketDetail_module_css_default.field,
										children: [(0, react_jsx_runtime.jsx)("span", {
											className: TicketDetail_module_css_default.fieldLabel,
											children: t("form.description")
										}), (0, react_jsx_runtime.jsx)("textarea", {
											className: TicketDetail_module_css_default.textarea,
											value: description,
											onChange: (event) => setDescription(event.target.value)
										})]
									}),
									(0, react_jsx_runtime.jsxs)("label", {
										className: TicketDetail_module_css_default.field,
										children: [(0, react_jsx_runtime.jsx)("span", {
											className: TicketDetail_module_css_default.fieldLabel,
											children: t("form.priority")
										}), (0, react_jsx_runtime.jsx)("select", {
											className: TicketDetail_module_css_default.input,
											value: priority,
											onChange: (event) => setPriority(event.target.value),
											children: PRIORITIES$1.map((value) => (0, react_jsx_runtime.jsx)("option", {
												value,
												children: t("priority." + value)
											}, value))
										})]
									}),
									(0, react_jsx_runtime.jsxs)("label", {
										className: TicketDetail_module_css_default.field,
										children: [(0, react_jsx_runtime.jsx)("span", {
											className: TicketDetail_module_css_default.fieldLabel,
											children: t("form.filesScope")
										}), (0, react_jsx_runtime.jsx)("textarea", {
											className: TicketDetail_module_css_default.textarea,
											value: filesScope,
											placeholder: t("form.filesScope.placeholder"),
											onChange: (event) => {
												setFilesScope(event.target.value);
											}
										})]
									}),
									(0, react_jsx_runtime.jsxs)("div", {
										className: TicketDetail_module_css_default.field,
										children: [(0, react_jsx_runtime.jsx)("span", {
											className: TicketDetail_module_css_default.fieldLabel,
											children: t("form.dependsOn")
										}), (0, react_jsx_runtime.jsx)("div", {
											className: TicketDetail_module_css_default.dependencyPicker,
											children: board.filter((candidate) => candidate.id !== ticket.id && candidate.column !== "done").map((candidate) => (0, react_jsx_runtime.jsxs)("label", {
												className: TicketDetail_module_css_default.dependencyOption,
												children: [(0, react_jsx_runtime.jsx)("input", {
													type: "checkbox",
													checked: dependsOn.includes(candidate.id),
													onChange: (event) => {
														setDependsOn((current) => event.target.checked ? [...current, candidate.id] : current.filter((id) => id !== candidate.id));
													}
												}), (0, react_jsx_runtime.jsx)("span", { children: candidate.title })]
											}, candidate.id))
										})]
									})
								]
							}),
							lastReview !== null && (0, react_jsx_runtime.jsxs)("section", {
								className: TicketDetail_module_css_default.reviewBox + (lastReview.outcome === "rejected" ? " " + TicketDetail_module_css_default.reviewRejected : " " + TicketDetail_module_css_default.reviewApproved),
								children: [
									(0, react_jsx_runtime.jsx)("h3", {
										className: TicketDetail_module_css_default.sectionTitle,
										children: `${t("detail.lastReview")} · ${t(lastReview.outcome === "rejected" ? "detail.lastReview.rejected" : "detail.lastReview.approved")}`
									}),
									(0, react_jsx_runtime.jsx)("p", {
										className: TicketDetail_module_css_default.paragraph,
										children: lastReview.feedback.trim() === "" ? "—" : lastReview.feedback
									}),
									(0, react_jsx_runtime.jsx)("p", {
										className: TicketDetail_module_css_default.reviewMeta,
										children: lastReview.reviewer.label
									})
								]
							}),
							ticket.history.length > 0 && (0, react_jsx_runtime.jsxs)("section", {
								className: TicketDetail_module_css_default.section,
								children: [(0, react_jsx_runtime.jsx)("h3", {
									className: TicketDetail_module_css_default.sectionTitle,
									children: t("detail.history")
								}), (0, react_jsx_runtime.jsx)("ol", {
									className: TicketDetail_module_css_default.historyList,
									children: [...ticket.history].reverse().map((row, index) => (0, react_jsx_runtime.jsxs)("li", {
										className: TicketDetail_module_css_default.historyRow,
										children: [(0, react_jsx_runtime.jsx)("span", {
											className: TicketDetail_module_css_default.historyDetail,
											children: row.detail
										}), (0, react_jsx_runtime.jsx)("span", {
											className: TicketDetail_module_css_default.historyTime,
											children: new Date(row.at).toLocaleString()
										})]
									}, index))
								})]
							})
						]
					}),
					(0, react_jsx_runtime.jsxs)("footer", {
						className: TicketDetail_module_css_default.footer,
						children: [
							!editing && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
								prevColumn !== null && (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: TicketDetail_module_css_default.button,
									onClick: () => {
										onMove(prevColumn);
									},
									children: t("action.moveLeft")
								}),
								nextColumn !== null && (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: TicketDetail_module_css_default.button,
									onClick: () => {
										onMove(nextColumn);
									},
									children: t("action.moveRight")
								}),
								ticket.column === "in_testing" && (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: TicketDetail_module_css_default.button,
									disabled: pending,
									onClick: () => {
										requestReview();
									},
									children: t("action.requestReview")
								}),
								(0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: TicketDetail_module_css_default.button,
									onClick: () => {
										setEditing(true);
									},
									children: t("action.edit")
								})
							] }),
							editing && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: TicketDetail_module_css_default.buttonPrimary,
								disabled: pending,
								onClick: () => {
									save();
								},
								children: t("action.save")
							}), (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: TicketDetail_module_css_default.button,
								onClick: () => {
									setEditing(false);
								},
								children: t("action.cancel")
							})] }),
							(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: armDelete ? TicketDetail_module_css_default.buttonDanger : TicketDetail_module_css_default.button,
								disabled: pending,
								onClick: () => {
									remove();
								},
								children: armDelete ? t("action.delete") + "?" : t("action.delete")
							})
						]
					})
				]
			});
		}
		//#endregion
		//#region \0dsh-css:C:\Users\O'yan'd'D'er\deepseek-harness\packages\client\ui-taskboard\src\client\NewTicketForm.module.css.mjs
		const css$1 = ".OU8bjW_overlay{background:var(--dsw-alias-bg-mask-1);justify-content:center;align-items:flex-start;padding-top:48px;display:flex;position:absolute;inset:0}.OU8bjW_dialog{background:var(--dsw-alias-bg-module-platform);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);width:420px;max-width:90%;box-shadow:var(--dsw-shadow-lv3);border:0;border-radius:10px;flex-direction:column;display:flex}.OU8bjW_header{border-bottom:.5px solid var(--dsw-alias-border-l2);padding:10px 12px}.OU8bjW_title{color:var(--dsw-alias-label-primary);margin:0;font-size:14px;line-height:20px}.OU8bjW_body{flex-direction:column;gap:10px;padding:12px;display:flex}.OU8bjW_field{flex-direction:column;gap:4px;display:flex}.OU8bjW_fieldLabel{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}.OU8bjW_input,.OU8bjW_textarea{background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);border-radius:6px;padding:6px 8px;font-size:12px;line-height:18px}.OU8bjW_textarea{resize:vertical;min-height:96px}.OU8bjW_dependencyPicker{flex-direction:column;gap:4px;max-height:160px;display:flex;overflow-y:auto}.OU8bjW_dependencyOption{color:var(--dsw-alias-label-secondary);align-items:center;gap:6px;font-size:12px;line-height:16px;display:flex}.OU8bjW_footer{border-top:.5px solid var(--dsw-alias-border-l2);gap:8px;padding:10px 12px;display:flex}.OU8bjW_button{background:var(--dsw-alias-button-tool-bar-fill);border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);cursor:pointer;border-radius:6px;padding:4px 10px;font-size:12px;line-height:18px}.OU8bjW_button:hover{background:var(--dsw-alias-button-tool-bar-hover)}.OU8bjW_buttonPrimary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted);cursor:pointer;border:1px solid #0000;border-radius:6px;padding:4px 10px;font-size:12px;line-height:18px}.OU8bjW_buttonPrimary:hover{background:var(--dsw-alias-button-primary-hover)}.OU8bjW_buttonPrimary:disabled{opacity:.6;cursor:default}";
		const tagId$1 = "@deepseek-ai/dsh-client-ui-taskboard/NewTicketForm.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-taskboard";
			tag.dataset.pluginCss = tagId$1;
			tag.textContent = css$1;
			document.head.appendChild(tag);
		}
		var NewTicketForm_module_css_default = {
			"body": "OU8bjW_body",
			"button": "OU8bjW_button",
			"buttonPrimary": "OU8bjW_buttonPrimary",
			"dependencyOption": "OU8bjW_dependencyOption",
			"dependencyPicker": "OU8bjW_dependencyPicker",
			"dialog": "OU8bjW_dialog",
			"field": "OU8bjW_field",
			"fieldLabel": "OU8bjW_fieldLabel",
			"footer": "OU8bjW_footer",
			"header": "OU8bjW_header",
			"input": "OU8bjW_input",
			"overlay": "OU8bjW_overlay",
			"textarea": "OU8bjW_textarea",
			"title": "OU8bjW_title"
		};
		//#endregion
		//#region lib/types/client/NewTicketForm.js
		/**
		* NewTicketForm: the create overlay. A new ticket always lands in Backlog;
		* the user picks title, description, priority, and ordering dependencies.
		*/
		const PRIORITIES = [
			"low",
			"normal",
			"high"
		];
		function NewTicketForm({ board, t, onSubmit, onCancel }) {
			const [title, setTitle] = (0, react.useState)("");
			const [description, setDescription] = (0, react.useState)("");
			const [priority, setPriority] = (0, react.useState)("normal");
			const [dependsOn, setDependsOn] = (0, react.useState)([]);
			const [filesScope, setFilesScope] = (0, react.useState)("");
			const [pending, setPending] = (0, react.useState)(false);
			const submit = async () => {
				if (title.trim() === "") return;
				setPending(true);
				try {
					await onSubmit({
						title,
						description,
						priority,
						dependsOn,
						filesScope
					});
				} finally {
					setPending(false);
				}
			};
			return (0, react_jsx_runtime.jsx)("div", {
				className: NewTicketForm_module_css_default.overlay,
				role: "dialog",
				"aria-label": t("action.new"),
				children: (0, react_jsx_runtime.jsxs)("div", {
					className: NewTicketForm_module_css_default.dialog,
					children: [
						(0, react_jsx_runtime.jsx)("header", {
							className: NewTicketForm_module_css_default.header,
							children: (0, react_jsx_runtime.jsx)("h2", {
								className: NewTicketForm_module_css_default.title,
								children: t("action.new")
							})
						}),
						(0, react_jsx_runtime.jsxs)("div", {
							className: NewTicketForm_module_css_default.body,
							children: [
								(0, react_jsx_runtime.jsxs)("label", {
									className: NewTicketForm_module_css_default.field,
									children: [(0, react_jsx_runtime.jsx)("span", {
										className: NewTicketForm_module_css_default.fieldLabel,
										children: t("form.title")
									}), (0, react_jsx_runtime.jsx)("input", {
										className: NewTicketForm_module_css_default.input,
										value: title,
										onChange: (event) => setTitle(event.target.value),
										autoFocus: true
									})]
								}),
								(0, react_jsx_runtime.jsxs)("label", {
									className: NewTicketForm_module_css_default.field,
									children: [(0, react_jsx_runtime.jsx)("span", {
										className: NewTicketForm_module_css_default.fieldLabel,
										children: t("form.description")
									}), (0, react_jsx_runtime.jsx)("textarea", {
										className: NewTicketForm_module_css_default.textarea,
										value: description,
										onChange: (event) => setDescription(event.target.value)
									})]
								}),
								(0, react_jsx_runtime.jsxs)("label", {
									className: NewTicketForm_module_css_default.field,
									children: [(0, react_jsx_runtime.jsx)("span", {
										className: NewTicketForm_module_css_default.fieldLabel,
										children: t("form.priority")
									}), (0, react_jsx_runtime.jsx)("select", {
										className: NewTicketForm_module_css_default.input,
										value: priority,
										onChange: (event) => setPriority(event.target.value),
										children: PRIORITIES.map((value) => (0, react_jsx_runtime.jsx)("option", {
											value,
											children: t("priority." + value)
										}, value))
									})]
								}),
								(0, react_jsx_runtime.jsxs)("label", {
									className: NewTicketForm_module_css_default.field,
									children: [(0, react_jsx_runtime.jsx)("span", {
										className: NewTicketForm_module_css_default.fieldLabel,
										children: t("form.filesScope")
									}), (0, react_jsx_runtime.jsx)("textarea", {
										className: NewTicketForm_module_css_default.textarea,
										value: filesScope,
										placeholder: t("form.filesScope.placeholder"),
										onChange: (event) => {
											setFilesScope(event.target.value);
										}
									})]
								}),
								(0, react_jsx_runtime.jsxs)("div", {
									className: NewTicketForm_module_css_default.field,
									children: [(0, react_jsx_runtime.jsx)("span", {
										className: NewTicketForm_module_css_default.fieldLabel,
										children: t("form.dependsOn")
									}), (0, react_jsx_runtime.jsx)("div", {
										className: NewTicketForm_module_css_default.dependencyPicker,
										children: board.filter((candidate) => candidate.column !== "done").map((candidate) => (0, react_jsx_runtime.jsxs)("label", {
											className: NewTicketForm_module_css_default.dependencyOption,
											children: [(0, react_jsx_runtime.jsx)("input", {
												type: "checkbox",
												checked: dependsOn.includes(candidate.id),
												onChange: (event) => {
													setDependsOn((current) => event.target.checked ? [...current, candidate.id] : current.filter((id) => id !== candidate.id));
												}
											}), (0, react_jsx_runtime.jsx)("span", { children: candidate.title })]
										}, candidate.id))
									})]
								})
							]
						}),
						(0, react_jsx_runtime.jsxs)("footer", {
							className: NewTicketForm_module_css_default.footer,
							children: [(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: NewTicketForm_module_css_default.buttonPrimary,
								disabled: pending || title.trim() === "",
								onClick: () => {
									submit();
								},
								children: t("action.save")
							}), (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: NewTicketForm_module_css_default.button,
								onClick: onCancel,
								children: t("action.cancel")
							})]
						})
					]
				})
			});
		}
		//#endregion
		//#region \0dsh-css:C:\Users\O'yan'd'D'er\deepseek-harness\packages\client\ui-taskboard\src\client\Board.module.css.mjs
		const css = ".zt205a_root{background:var(--dsw-alias-bg-base);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);flex-direction:column;height:100%;display:flex;position:relative;overflow:hidden}.zt205a_header{border-bottom:.5px solid var(--dsw-alias-border-l2);align-items:center;gap:8px;padding:10px 12px;display:flex}.zt205a_title{color:var(--dsw-alias-label-primary);margin:0;font-size:15px;line-height:22px}.zt205a_count{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}.zt205a_headerActions{align-items:center;gap:6px;margin-left:auto;display:flex}.zt205a_boardSelector{align-items:center;gap:6px;max-width:340px;margin-left:12px;display:flex}.zt205a_boardSelect{background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);border-radius:6px;max-width:180px;padding:4px 8px;font-size:12px;line-height:18px}.zt205a_scopeBadge{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);white-space:nowrap;border-radius:10px;padding:1px 6px;font-size:11px;line-height:16px}.zt205a_archiveButton,.zt205a_createButton,.zt205a_confirmButton,.zt205a_cancelButton,.zt205a_secondaryButton{border:.5px solid var(--dsw-alias-border-l2);cursor:pointer;background:0 0;border-radius:6px;padding:4px 8px;font-size:12px;line-height:18px}.zt205a_archiveButton,.zt205a_createButton,.zt205a_confirmButton,.zt205a_secondaryButton{color:var(--dsw-alias-label-secondary)}.zt205a_archiveButton:hover,.zt205a_createButton:hover,.zt205a_confirmButton:hover,.zt205a_secondaryButton:hover{border-color:var(--dsw-alias-interactive-bg-hover-solid)}.zt205a_cancelButton{color:var(--dsw-alias-label-tertiary)}.zt205a_confirmButton{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}.zt205a_archiveConfirm{align-items:center;gap:6px;display:flex}.zt205a_archiveConfirmText{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}.zt205a_newBoardForm{border-bottom:.5px solid var(--dsw-alias-border-l2);align-items:center;gap:6px;padding:6px 12px;display:flex}.zt205a_boardNameInput{background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);min-width:160px;color:var(--dsw-alias-label-primary);border-radius:6px;flex:1;padding:4px 8px;font-size:12px;line-height:18px}.zt205a_boardScopeSelect{background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);border-radius:6px;padding:4px 8px;font-size:12px;line-height:18px}.zt205a_newButton{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted);cursor:pointer;border:1px solid #0000;border-radius:6px;padding:4px 12px;font-size:12px;line-height:18px}.zt205a_newButton:hover{background:var(--dsw-alias-button-primary-hover)}.zt205a_seatBanner{background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);white-space:nowrap;border-radius:10px;align-items:center;gap:6px;margin-left:12px;padding:2px 8px;display:flex}.zt205a_seatText{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}.zt205a_seatText[data-expiring=true]{color:var(--dsw-alias-state-warning-primary,#b7791f)}.zt205a_seatText[data-expired=true]{color:var(--dsw-alias-state-error-primary)}.zt205a_copyButton{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted);cursor:pointer;border:1px solid #0000;border-radius:6px;padding:2px 8px;font-size:11px;line-height:16px}.zt205a_copyButton:hover{background:var(--dsw-alias-button-primary-hover)}.zt205a_seatCopyState{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}.zt205a_seatCopyState[data-copy=failed]{color:var(--dsw-alias-state-error-primary)}.zt205a_errorBanner{background:var(--dsw-alias-state-error-secondary);color:var(--dsw-alias-state-error-primary);justify-content:space-between;align-items:center;gap:8px;padding:6px 12px;font-size:12px;line-height:18px;display:flex}.zt205a_errorClose{color:inherit;cursor:pointer;background:0 0;border:none;font-size:16px;line-height:18px}.zt205a_board{flex:1;grid-template-rows:minmax(0,100%);grid-template-columns:repeat(5,minmax(200px,1fr));gap:10px;padding:12px;display:grid;overflow-x:auto}.zt205a_column{background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;flex-direction:column;gap:8px;min-height:120px;max-height:100%;padding:8px;display:flex;overflow-y:auto}.zt205a_columnDropTarget{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2);box-shadow:inset 0 0 0 2px var(--dsw-alias-brand-primary)}.zt205a_dropIndicator{background:var(--dsw-alias-brand-primary);height:3px;box-shadow:0 0 0 1px var(--dsw-alias-bg-layer-1);border-radius:2px;flex:none;margin:2px 0}.zt205a_columnHeader{align-items:baseline;gap:6px;padding:2px 4px;display:flex}.zt205a_columnName{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:18px}.zt205a_columnGloss{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}.zt205a_columnCount{color:var(--dsw-alias-label-dimmed);margin-left:auto;font-size:11px;line-height:16px}.zt205a_cards{flex-direction:column;flex:1;gap:8px;min-height:24px;display:flex}.zt205a_empty{color:var(--dsw-alias-label-dimmed);margin:8px 4px;font-size:12px;line-height:18px}";
		const tagId = "@deepseek-ai/dsh-client-ui-taskboard/Board.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-taskboard";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var Board_module_css_default = {
			"archiveButton": "zt205a_archiveButton",
			"archiveConfirm": "zt205a_archiveConfirm",
			"archiveConfirmText": "zt205a_archiveConfirmText",
			"board": "zt205a_board",
			"boardNameInput": "zt205a_boardNameInput",
			"boardScopeSelect": "zt205a_boardScopeSelect",
			"boardSelect": "zt205a_boardSelect",
			"boardSelector": "zt205a_boardSelector",
			"cancelButton": "zt205a_cancelButton",
			"cards": "zt205a_cards",
			"column": "zt205a_column",
			"columnCount": "zt205a_columnCount",
			"columnDropTarget": "zt205a_columnDropTarget",
			"columnGloss": "zt205a_columnGloss",
			"columnHeader": "zt205a_columnHeader",
			"columnName": "zt205a_columnName",
			"confirmButton": "zt205a_confirmButton",
			"copyButton": "zt205a_copyButton",
			"count": "zt205a_count",
			"createButton": "zt205a_createButton",
			"dropIndicator": "zt205a_dropIndicator",
			"empty": "zt205a_empty",
			"errorBanner": "zt205a_errorBanner",
			"errorClose": "zt205a_errorClose",
			"header": "zt205a_header",
			"headerActions": "zt205a_headerActions",
			"newBoardForm": "zt205a_newBoardForm",
			"newButton": "zt205a_newButton",
			"root": "zt205a_root",
			"scopeBadge": "zt205a_scopeBadge",
			"seatBanner": "zt205a_seatBanner",
			"seatCopyState": "zt205a_seatCopyState",
			"seatText": "zt205a_seatText",
			"secondaryButton": "zt205a_secondaryButton",
			"title": "zt205a_title"
		};
		//#endregion
		//#region lib/types/client/TaskboardView.js
		/**
		* TaskboardView: the five-column kanban tab. Columns render from the live
		* board snapshot; cards drag between columns with HTML5 drag events; the
		* detail panel and the new-ticket form overlay the board. All verbs come from
		* the injected face, all live data from the bound useBoard hook.
		*/
		/** The five workflow columns in canonical left-to-right order. */
		const COLUMNS = [
			"backlog",
			"not_started",
			"in_progress",
			"in_testing",
			"done"
		];
		/** How close to the master-lease expiry the banner starts warning. */
		const SEAT_LEASE_WARNING_MS = 6e4;
		/** Short display handle for one session id (strips the session- prefix). */
		function shortSessionId(id) {
			const bare = id.startsWith("session-") ? id.slice(8) : id;
			return bare.length > 8 ? bare.slice(0, 8) : bare;
		}
		function TaskboardView({ useBoard, useStore, actions, create, move, edit, remove, requestReview, selectBoard, createBoard, archiveBoard, t, dragAutoScroll }) {
			const boardState = useBoard((state) => state);
			const board = boardState.snapshot;
			const selectedId = useStore((state) => state.selectedId);
			const [formOpen, setFormOpen] = (0, react.useState)(false);
			const [newBoardOpen, setNewBoardOpen] = (0, react.useState)(false);
			const [boardName, setBoardName] = (0, react.useState)("");
			const [boardScope, setBoardScope] = (0, react.useState)("session");
			const [confirmArchive, setConfirmArchive] = (0, react.useState)(false);
			const [draggingId, setDraggingId] = (0, react.useState)(null);
			const [dropTarget, setDropTarget] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)(null);
			const [copyState, setCopyState] = (0, react.useState)("idle");
			/** The scrollable board strip (horizontal auto-scroll while dragging). */
			const boardRef = (0, react.useRef)(null);
			/** Last drag pointer position plus the column under it (vertical scroll). */
			const dragPointRef = (0, react.useRef)(null);
			/** Pending animation-frame id of the drag auto-scroll loop. */
			const autoScrollRafRef = (0, react.useRef)(null);
			/** Edge auto-scroll tuning; caller-supplied values win over the defaults. */
			const autoScrollConfig = {
				threshold: dragAutoScroll?.threshold ?? DRAG_AUTO_SCROLL_DEFAULTS.threshold,
				speed: dragAutoScroll?.speed ?? DRAG_AUTO_SCROLL_DEFAULTS.speed
			};
			/** Stop the drag auto-scroll loop and forget the pointer. */
			const stopAutoScroll = () => {
				if (autoScrollRafRef.current !== null) cancelAnimationFrame(autoScrollRafRef.current);
				autoScrollRafRef.current = null;
				dragPointRef.current = null;
			};
			(0, react.useEffect)(() => () => {
				if (autoScrollRafRef.current !== null) cancelAnimationFrame(autoScrollRafRef.current);
				autoScrollRafRef.current = null;
				dragPointRef.current = null;
			}, []);
			/** Column id → ordered tickets, derived purely from the snapshot. */
			const byColumn = (0, react.useMemo)(() => {
				const map = /* @__PURE__ */ new Map();
				for (const column of COLUMNS) map.set(column, []);
				for (const ticket of board?.tickets ?? []) {
					const rows = map.get(ticket.column);
					if (rows !== void 0) rows.push(ticket);
				}
				return map;
			}, [board]);
			const selected = board === null ? null : board.tickets.find((ticket) => ticket.id === selectedId) ?? null;
			const ticketCount = board?.tickets.length ?? 0;
			/**
			* Master-seat banner state for the active board: vacant, held (with a
			* lease about to expire warning) or expired. The host reports
			* masterExpiresAt (claim time plus the configured lease), so the expiring
			* and expired states are exact. A lapsed lease means the seat is
			* preemptable again, so the banner reads as expired rather than being
			* permanently "about to expire" and re-offers the takeover affordance.
			*/
			const masterLabel = boardState.masterAgentId === null ? null : shortSessionId(boardState.masterAgentId);
			const masterHeld = boardState.masterAgentId !== null && boardState.masterExpiresAt !== null;
			const masterExpired = masterHeld && boardState.masterExpiresAt !== null && boardState.masterExpiresAt <= Date.now();
			const masterExpiring = masterHeld && !masterExpired && boardState.masterExpiresAt !== null && boardState.masterExpiresAt - Date.now() < SEAT_LEASE_WARNING_MS;
			/** Copy the standard takeover script for a vacant seat into the clipboard. */
			const copyTakeover = async () => {
				const script = t("seat.takeover").replaceAll("{boardId}", boardState.boardId).replaceAll("{boardName}", board?.name ?? boardState.boardId);
				try {
					if (navigator.clipboard !== void 0) await navigator.clipboard.writeText(script);
					else throw new Error("clipboard unavailable");
					setCopyState("copied");
				} catch {
					setCopyState("failed");
				}
			};
			/**
			* Active boards for the selector, grouped by scope; archived ones collapse
			* into a group. Only the current project's boards render (the host already
			* filters, so this is defense-in-depth): a board owned by another workspace
			* is never selectable here, while unowned boards stay shared. A session-
			* private board (scope 'session') is shown only through its own session's
			* list; anything without a scope marker reads as project-shared.
			*/
			const workspaceId = boardState.workspaceId;
			const inWorkspace = (item) => item.workspaceId === workspaceId || item.workspaceId === "";
			const activeBoards = boardState.boards.filter((item) => item.archivedAt === null && inWorkspace(item));
			const archivedBoards = boardState.boards.filter((item) => item.archivedAt !== null && inWorkspace(item));
			const sessionBoards = activeBoards.filter((item) => item.scope === "session");
			const projectBoards = activeBoards.filter((item) => item.scope !== "session");
			/** One option label: the board name plus its scope badge. */
			const boardLabel = (item) => {
				const name = item.name || item.boardId;
				const scopeKey = item.scope === "session" ? "session" : "project";
				return name + "（" + t("board.scope." + scopeKey) + "）";
			};
			/** Create one board from the inline name and scope fields and open it. */
			const handleCreateBoard = async () => {
				const name = boardName.trim();
				if (name === "") return;
				try {
					await createBoard(name, boardScope);
					setNewBoardOpen(false);
					setBoardName("");
					setBoardScope("session");
					setError(null);
				} catch {
					setError(t("error.generic"));
				}
			};
			/** Archive the active board after the inline confirmation. */
			const handleArchive = async () => {
				try {
					await archiveBoard(boardState.boardId);
					setError(null);
				} catch {
					setError(t("error.generic"));
				}
			};
			/** One auto-scroll tick: scroll the column vertically and the board horizontally. */
			const autoScrollTick = () => {
				autoScrollRafRef.current = null;
				const point = dragPointRef.current;
				if (point === null) return;
				const { clientX, clientY, columnEl } = point;
				if (columnEl !== null) {
					const rect = columnEl.getBoundingClientRect();
					const deltaY = autoScrollDelta(clientY, rect.top, rect.height, autoScrollConfig.threshold, autoScrollConfig.speed);
					if (deltaY !== 0) columnEl.scrollTop = Math.max(0, columnEl.scrollTop + deltaY);
				}
				const board = boardRef.current;
				if (board !== null) {
					const rect = board.getBoundingClientRect();
					const deltaX = autoScrollDelta(clientX, rect.left, rect.width, autoScrollConfig.threshold, autoScrollConfig.speed);
					if (deltaX !== 0) board.scrollLeft = Math.max(0, board.scrollLeft + deltaX);
				}
				autoScrollRafRef.current = requestAnimationFrame(autoScrollTick);
			};
			/** Keep the auto-scroll loop alive while a drag is in flight. */
			const ensureAutoScroll = (clientX, clientY, columnEl) => {
				dragPointRef.current = {
					clientX,
					clientY,
					columnEl
				};
				if (autoScrollRafRef.current === null) autoScrollRafRef.current = requestAnimationFrame(autoScrollTick);
			};
			/** Commit one drag-drop move and surface failures in the banner. */
			const handleDrop = async (column) => {
				const id = draggingId;
				const before = dropTarget !== null && dropTarget.column === column ? dropTarget.beforeTicketId : null;
				setDraggingId(null);
				setDropTarget(null);
				stopAutoScroll();
				if (id === null) return;
				const request = {
					ticketId: id,
					column,
					beforeTicketId: before,
					afterTicketId: null
				};
				try {
					await move(request);
					setError(null);
				} catch {
					setError(t("error.generic"));
				}
			};
			/** Arm one drag session from a card. */
			const handleDragStart = (id) => {
				setDraggingId(id);
				setDropTarget(null);
				dragPointRef.current = null;
				if (autoScrollRafRef.current === null) autoScrollRafRef.current = requestAnimationFrame(autoScrollTick);
			};
			/** Track the pointer for auto-scroll while dragging over one column. */
			const handleColumnDragOver = (event) => {
				if (draggingId === null) return;
				event.preventDefault();
				event.dataTransfer.dropEffect = "move";
				ensureAutoScroll(event.clientX, event.clientY, event.currentTarget);
			};
			/** Track the pointer for horizontal auto-scroll over the board strip. */
			const handleBoardDragOver = (event) => {
				if (draggingId === null) return;
				if (event.target !== event.currentTarget) return;
				ensureAutoScroll(event.clientX, event.clientY, null);
			};
			return (0, react_jsx_runtime.jsxs)("div", {
				className: Board_module_css_default.root,
				children: [
					(0, react_jsx_runtime.jsxs)("header", {
						className: Board_module_css_default.header,
						children: [
							(0, react_jsx_runtime.jsx)("h1", {
								className: Board_module_css_default.title,
								children: t("view.taskboard")
							}),
							(0, react_jsx_runtime.jsx)("span", {
								className: Board_module_css_default.count,
								children: String(ticketCount)
							}),
							(0, react_jsx_runtime.jsxs)("div", {
								className: Board_module_css_default.boardSelector,
								children: [
									(0, react_jsx_runtime.jsxs)("select", {
										className: Board_module_css_default.boardSelect,
										"aria-label": t("board.select"),
										value: boardState.boardId,
										onChange: (event) => {
											selectBoard(event.target.value);
										},
										children: [
											sessionBoards.length > 0 && (0, react_jsx_runtime.jsx)("optgroup", {
												label: t("board.group.session"),
												children: sessionBoards.map((boardRow) => (0, react_jsx_runtime.jsx)("option", {
													value: boardRow.boardId,
													children: boardLabel(boardRow)
												}, boardRow.boardId))
											}),
											projectBoards.length > 0 && (0, react_jsx_runtime.jsx)("optgroup", {
												label: t("board.group.project"),
												children: projectBoards.map((boardRow) => (0, react_jsx_runtime.jsx)("option", {
													value: boardRow.boardId,
													children: boardLabel(boardRow)
												}, boardRow.boardId))
											}),
											archivedBoards.length > 0 && (0, react_jsx_runtime.jsx)("optgroup", {
												label: t("board.archived"),
												children: archivedBoards.map((boardRow) => (0, react_jsx_runtime.jsx)("option", {
													value: boardRow.boardId,
													disabled: true,
													children: boardLabel(boardRow)
												}, boardRow.boardId))
											})
										]
									}),
									(0, react_jsx_runtime.jsx)("span", {
										className: Board_module_css_default.scopeBadge,
										"data-scope": boardState.scope,
										children: t("board.scope." + boardState.scope)
									}),
									!confirmArchive ? (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: Board_module_css_default.archiveButton,
										onClick: () => setConfirmArchive(true),
										children: t("board.archive")
									}) : (0, react_jsx_runtime.jsxs)("span", {
										className: Board_module_css_default.archiveConfirm,
										children: [
											(0, react_jsx_runtime.jsx)("span", {
												className: Board_module_css_default.archiveConfirmText,
												children: t("board.archiveConfirm")
											}),
											(0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: Board_module_css_default.confirmButton,
												onClick: () => {
													setConfirmArchive(false);
													handleArchive();
												},
												children: t("board.confirm")
											}),
											(0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: Board_module_css_default.cancelButton,
												onClick: () => setConfirmArchive(false),
												children: t("action.cancel")
											})
										]
									})
								]
							}),
							(0, react_jsx_runtime.jsx)("div", {
								className: Board_module_css_default.seatBanner,
								"data-seat": boardState.masterAgentId === null ? "vacant" : masterExpired ? "expired" : "held",
								children: boardState.masterAgentId === null || masterExpired ? (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
									(0, react_jsx_runtime.jsx)("span", {
										className: Board_module_css_default.seatText,
										"data-expired": masterExpired || void 0,
										children: boardState.masterAgentId === null ? t("seat.vacant") : t("seat.expired")
									}),
									(0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: Board_module_css_default.copyButton,
										onClick: () => {
											copyTakeover();
										},
										children: t("seat.copyTakeover")
									}),
									copyState !== "idle" && (0, react_jsx_runtime.jsx)("span", {
										className: Board_module_css_default.seatCopyState,
										"data-copy": copyState,
										children: copyState === "copied" ? t("seat.copied") : t("seat.copyFailed")
									})
								] }) : (0, react_jsx_runtime.jsxs)("span", {
									className: Board_module_css_default.seatText,
									"data-expiring": masterExpiring,
									children: [t("seat.holder").replace("{holder}", masterLabel ?? ""), masterExpiring ? " · " + t("seat.expiring") : ""]
								})
							}),
							(0, react_jsx_runtime.jsxs)("div", {
								className: Board_module_css_default.headerActions,
								children: [(0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: Board_module_css_default.secondaryButton,
									onClick: () => setNewBoardOpen((open) => !open),
									children: t("board.new")
								}), (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: Board_module_css_default.newButton,
									onClick: () => setFormOpen(true),
									children: t("action.new")
								})]
							})
						]
					}),
					newBoardOpen && (0, react_jsx_runtime.jsxs)("form", {
						className: Board_module_css_default.newBoardForm,
						onSubmit: (event) => {
							event.preventDefault();
							handleCreateBoard();
						},
						children: [
							(0, react_jsx_runtime.jsx)("input", {
								className: Board_module_css_default.boardNameInput,
								value: boardName,
								onChange: (event) => setBoardName(event.target.value),
								placeholder: t("board.newName"),
								"aria-label": t("board.newName")
							}),
							(0, react_jsx_runtime.jsxs)("select", {
								className: Board_module_css_default.boardScopeSelect,
								value: boardScope,
								onChange: (event) => {
									setBoardScope(event.target.value);
								},
								"aria-label": t("board.scope"),
								children: [(0, react_jsx_runtime.jsx)("option", {
									value: "session",
									children: t("board.scope.session")
								}), (0, react_jsx_runtime.jsx)("option", {
									value: "project",
									children: t("board.scope.project")
								})]
							}),
							(0, react_jsx_runtime.jsx)("button", {
								type: "submit",
								className: Board_module_css_default.createButton,
								disabled: boardName.trim() === "",
								children: t("board.create")
							}),
							(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: Board_module_css_default.cancelButton,
								onClick: () => {
									setNewBoardOpen(false);
									setBoardName("");
									setBoardScope("session");
								},
								children: t("action.cancel")
							})
						]
					}),
					error !== null && (0, react_jsx_runtime.jsxs)("div", {
						className: Board_module_css_default.errorBanner,
						role: "alert",
						children: [(0, react_jsx_runtime.jsx)("span", { children: error }), (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: Board_module_css_default.errorClose,
							onClick: () => setError(null),
							"aria-label": t("action.close"),
							children: "×"
						})]
					}),
					(0, react_jsx_runtime.jsx)("div", {
						className: Board_module_css_default.board,
						ref: boardRef,
						onDragOver: handleBoardDragOver,
						children: COLUMNS.map((column) => {
							const tickets = byColumn.get(column) ?? [];
							const gloss = t("column." + column + ".gloss");
							const isDropTarget = dropTarget !== null && dropTarget.column === column;
							/** Slot the drop lands in: the index to insert before (length = append). */
							const dropSlot = isDropTarget ? insertionSlot(tickets.map((ticket) => ticket.id), dropTarget.beforeTicketId) : -1;
							return (0, react_jsx_runtime.jsxs)("section", {
								className: Board_module_css_default.column + (isDropTarget ? " " + Board_module_css_default.columnDropTarget : ""),
								"data-column": column,
								onDragOver: (event) => {
									handleColumnDragOver(event);
									if (draggingId === null) return;
									const spans = Array.from(event.currentTarget.querySelectorAll("[data-ticket-id]")).map((element) => {
										const rect = element.getBoundingClientRect();
										return {
											top: rect.top,
											bottom: rect.bottom
										};
									});
									const index = insertionIndexAt(event.clientY, spans);
									setDropTarget({
										column,
										beforeTicketId: index < tickets.length ? tickets[index]?.id ?? null : null
									});
								},
								onDrop: (event) => {
									event.preventDefault();
									handleDrop(column);
								},
								children: [(0, react_jsx_runtime.jsxs)("div", {
									className: Board_module_css_default.columnHeader,
									children: [
										(0, react_jsx_runtime.jsx)("span", {
											className: Board_module_css_default.columnName,
											children: t("column." + column)
										}),
										gloss !== "" && (0, react_jsx_runtime.jsx)("span", {
											className: Board_module_css_default.columnGloss,
											children: gloss
										}),
										(0, react_jsx_runtime.jsx)("span", {
											className: Board_module_css_default.columnCount,
											children: String(tickets.length)
										})
									]
								}), (0, react_jsx_runtime.jsxs)("div", {
									className: Board_module_css_default.cards,
									children: [
										tickets.map((ticket, index) => (0, react_jsx_runtime.jsxs)(react.Fragment, { children: [dropSlot === index && (0, react_jsx_runtime.jsx)("div", {
											className: Board_module_css_default.dropIndicator,
											"data-testid": "drop-indicator"
										}), (0, react_jsx_runtime.jsx)(TicketCard, {
											ticket,
											selected: ticket.id === selectedId,
											dragging: ticket.id === draggingId,
											t,
											onSelect: () => {
												actions.select(ticket.id);
											},
											onDragStart: () => {
												handleDragStart(ticket.id);
											},
											onDragEnd: () => {
												setDraggingId(null);
												setDropTarget(null);
												stopAutoScroll();
											}
										})] }, ticket.id)),
										dropSlot === tickets.length && (0, react_jsx_runtime.jsx)("div", {
											className: Board_module_css_default.dropIndicator,
											"data-testid": "drop-indicator"
										}),
										tickets.length === 0 && ticketCount === 0 && column === "backlog" && (0, react_jsx_runtime.jsx)("p", {
											className: Board_module_css_default.empty,
											children: t("board.empty")
										})
									]
								})]
							}, column);
						})
					}),
					selected !== null && (0, react_jsx_runtime.jsx)(TicketDetail, {
						ticket: selected,
						board: board?.tickets ?? [],
						t,
						onClose: () => {
							actions.select(null);
						},
						onEdit: edit,
						onRemove: remove,
						onRequestReview: requestReview,
						onMove: (target) => {
							handleMove(target);
						},
						onError: (message) => {
							setError(message);
						}
					}),
					formOpen && (0, react_jsx_runtime.jsx)(NewTicketForm, {
						board: board?.tickets ?? [],
						t,
						onSubmit: async (request) => {
							try {
								await create(request);
								setFormOpen(false);
								setError(null);
							} catch {
								setError(t("error.generic"));
							}
						},
						onCancel: () => setFormOpen(false)
					})
				]
			});
			/** Adjacent-column moves from the detail panel reuse the same verb. */
			async function handleMove(target) {
				if (selected === null) return;
				const request = {
					ticketId: selected.id,
					column: target,
					beforeTicketId: null,
					afterTicketId: null
				};
				try {
					await move(request);
					setError(null);
				} catch {
					setError(t("error.generic"));
				}
			}
		}
		//#endregion
		//#region lib/types/client/locales.js
		/** `taskboard` namespace dictionaries. */
		/** Simplified Chinese dictionary (the key-set source of truth). */
		const zh = {
			"view.taskboard": "工单看板",
			"column.backlog": "Backlog",
			"column.backlog.gloss": "待办池",
			"column.not_started": "Not started",
			"column.not_started.gloss": "未开始",
			"column.in_progress": "In progress",
			"column.in_progress.gloss": "进行中",
			"column.in_testing": "In testing",
			"column.in_testing.gloss": "测试中",
			"column.done": "Done",
			"column.done.gloss": "已完成",
			"priority.low": "低",
			"priority.normal": "普通",
			"priority.high": "高",
			"action.new": "新建工单",
			"action.close": "关闭",
			"type.feature": "功能",
			"type.bugfix": "缺陷修复",
			"type.refactor": "重构",
			"type.docs": "文档",
			"type.test": "测试",
			"type.merge": "合并",
			"type.infra": "基础设施",
			"type.chore": "杂务",
			"type.spike": "探索",
			"board.select": "选择看板",
			"board.group.session": "本会话私有板",
			"board.group.project": "项目共享板",
			"board.scope": "作用域",
			"board.scope.session": "本会话私有",
			"board.scope.project": "项目共享",
			"board.new": "新建板",
			"board.newName": "看板名称",
			"board.create": "创建",
			"board.confirm": "确认",
			"board.archive": "归档",
			"board.archiveConfirm": "确认归档此板？",
			"board.archived": "已归档",
			"action.save": "保存",
			"action.cancel": "取消",
			"action.delete": "删除",
			"action.edit": "编辑",
			"action.moveLeft": "移到上一列",
			"action.moveRight": "移到下一列",
			"action.requestReview": "重新送审",
			"form.title": "标题",
			"form.description": "描述",
			"form.priority": "优先级",
			"form.dependsOn": "依赖工单",
			"form.filesScope": "影响文件范围",
			"form.filesScope.placeholder": "如 src/parser.ts、packages/client/ui-taskboard/src（留空表示未声明）",
			"detail.filesScope": "影响文件范围",
			"detail.assignee": "开发",
			"detail.reviewer": "审核",
			"detail.reviewAttempts": "审核次数",
			"detail.devNotes": "开发备注",
			"detail.lastReview": "最近审核",
			"detail.lastReview.approved": "通过",
			"detail.lastReview.rejected": "驳回",
			"detail.history": "历史",
			"detail.empty": "选择一张卡片查看详情。",
			"board.empty": "还没有工单。点击右上角\"新建工单\"开始。",
			"seat.vacant": "席位空缺",
			"seat.holder": "席位由 {holder} 持有",
			"seat.expiring": "租期将尽",
			"seat.expired": "已过期，可抢占",
			"seat.copyTakeover": "复制接管指令",
			"seat.copied": "已复制",
			"seat.copyFailed": "复制失败",
			"seat.takeover": "请接管任务看板 board \"{boardId}\"（\"{boardName}\"）：调用 taskboard_claim_master（boardId \"{boardId}\"）认领 master 席位；claim 返回的 handoverNotes 包含各卡状态、worker 身份、在审审核席位与待办摘要，据此继续派单（taskboard_assign）与裁决审核（taskboard_resolve_review）。",
			"board.loading": "加载中…",
			"state.unassigned": "未领取",
			"state.reviewing": "审核中",
			"state.rejected": "已驳回，返修中",
			"state.approved": "已通过",
			"state.paused": "已暂停",
			"state.attempts": "审核 {count} 次",
			"error.generic": "操作失败，请重试。"
		};
		/** English dictionary, checked complete against the zh key set. */
		const en = {
			"view.taskboard": "Taskboard",
			"column.backlog": "Backlog",
			"column.backlog.gloss": "",
			"column.not_started": "Not started",
			"column.not_started.gloss": "",
			"column.in_progress": "In progress",
			"column.in_progress.gloss": "",
			"column.in_testing": "In testing",
			"column.in_testing.gloss": "",
			"column.done": "Done",
			"column.done.gloss": "",
			"priority.low": "Low",
			"priority.normal": "Normal",
			"priority.high": "High",
			"action.new": "New ticket",
			"action.close": "Close",
			"type.feature": "Feature",
			"type.bugfix": "Bugfix",
			"type.refactor": "Refactor",
			"type.docs": "Docs",
			"type.test": "Test",
			"type.merge": "Merge",
			"type.infra": "Infra",
			"type.chore": "Chore",
			"type.spike": "Spike",
			"board.select": "Select board",
			"board.group.session": "This session's boards",
			"board.group.project": "Project shared boards",
			"board.scope": "Scope",
			"board.scope.session": "This session",
			"board.scope.project": "Project shared",
			"board.new": "New board",
			"board.newName": "Board name",
			"board.create": "Create",
			"board.confirm": "Confirm",
			"board.archive": "Archive",
			"board.archiveConfirm": "Archive this board?",
			"board.archived": "Archived",
			"action.save": "Save",
			"action.cancel": "Cancel",
			"action.delete": "Delete",
			"action.edit": "Edit",
			"action.moveLeft": "Move left",
			"action.moveRight": "Move right",
			"action.requestReview": "Request review",
			"form.title": "Title",
			"form.description": "Description",
			"form.priority": "Priority",
			"form.dependsOn": "Depends on",
			"form.filesScope": "Affected files",
			"form.filesScope.placeholder": "e.g. src/parser.ts, packages/client/ui-taskboard/src (empty = not declared)",
			"detail.filesScope": "Affected files",
			"detail.assignee": "Developer",
			"detail.reviewer": "Reviewer",
			"detail.reviewAttempts": "Review rounds",
			"detail.devNotes": "Developer notes",
			"detail.lastReview": "Latest review",
			"detail.lastReview.approved": "Approved",
			"detail.lastReview.rejected": "Rejected",
			"detail.history": "History",
			"detail.empty": "Select a card to see details.",
			"board.empty": "No tickets yet. Click \"New ticket\" at the top right to start.",
			"seat.vacant": "Master seat vacant",
			"seat.holder": "Master seat held by {holder}",
			"seat.expiring": "lease expiring soon",
			"seat.expired": "expired, preemptable",
			"seat.copyTakeover": "Copy takeover script",
			"seat.copied": "Copied",
			"seat.copyFailed": "Copy failed",
			"seat.takeover": "Take over the taskboard board \"{boardId}\" (\"{boardName}\"): call taskboard_claim_master (boardId \"{boardId}\") to claim the master seat; the claim result's handoverNotes lists every card status, worker identity, review seats and the backlog summary — continue dispatching (taskboard_assign) and adjudicating reviews (taskboard_resolve_review) from there.",
			"board.loading": "Loading…",
			"state.unassigned": "Unassigned",
			"state.reviewing": "Under review",
			"state.rejected": "Rejected, reworking",
			"state.approved": "Approved",
			"state.paused": "Paused",
			"state.attempts": "{count} review round(s)",
			"error.generic": "The operation failed. Try again."
		};
		//#endregion
		//#region lib/types/client/index.js
		/** Dictionary namespace owned by this plugin. */
		const NS = "taskboard";
		/** Required services for the board tab, Remote verbs, and copy. */
		const inject = [
			"slots",
			"sessions",
			"workspaces",
			"remote",
			"remote.taskboard",
			"locale"
		];
		/** Unwrap one Remote result; failures become plain rejections. */
		function unwrap(result) {
			if (!result.ok) throw new Error(result.error.message);
			return result.value;
		}
		/**
		* Pick the effective active board for a fetch: the requested board when the
		* session can see it, otherwise the first visible board. The requested id
		* only survives as the pre-fetch placeholder when no board exists yet. This
		* keeps the first load alive when the legacy 'default' board was adopted by
		* another workspace and the host denies its snapshot.
		* @param boardId - the board the caller asked to render.
		* @param boards - the board list the host reports as visible to the session.
		* @returns the board id to snapshot: the request when visible, else the first visible board, else the request.
		*/
		function pickBoardTarget(boardId, boards) {
			if (boards.some((board) => board.boardId === boardId)) return boardId;
			return boards[0]?.boardId ?? boardId;
		}
		/**
		* Client plugin body: the conversation.view tab with its verbs and live
		* board-state sources.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "ui-taskboard: dictionaries");
			const t = ctx.locale.bind(NS);
			/**
			* Per-session board state sources: the host scopes snapshot/listBoards/
			* createBoard to the calling session's workspace, so every session tab
			* keeps its own board list and active-board snapshot, fetched with that
			* session's id. A source is created on the tab's first inject (the
			* renderer caches inject results per session cell) and stays warm across
			* tab switches, so a returning session shows its own boards immediately.
			*/
			const sources = /* @__PURE__ */ new Map();
			/** Resolve one session's owning workspace id; '' when unowned or unknown. */
			const workspaceOf = (sessionId) => {
				return ctx.workspaces.list.getSnapshot().items.find((workspace) => workspace.sessionIds.includes(sessionId))?.workspaceId ?? "";
			};
			/** Build one session's board state source. */
			const makeSource = (sessionId) => {
				let current = {
					boardId: "default",
					boards: [],
					snapshot: null,
					workspaceId: workspaceOf(sessionId),
					scope: "project",
					ownerSessionId: null,
					masterAgentId: null,
					masterClaimedAt: null,
					masterExpiresAt: null
				};
				const listeners = /* @__PURE__ */ new Set();
				const publish = () => {
					for (const listener of listeners) listener();
				};
				/**
				* Fetch the board list and the active board's snapshot. The list is
				* authoritative for visibility: when the requested board is not in it
				* (the legacy 'default' may belong to another workspace under project
				* isolation), the first visible board becomes the effective active
				* board instead of failing the whole first load. A snapshot failure
				* degrades to an empty snapshot while keeping the fetched board list,
				* so the selector never loses the boards it already knows about.
				*/
				const fetchBoardState = async (boardId) => {
					const boards = unwrap(await ctx.remote.taskboard.listBoards(sessionId));
					const target = pickBoardTarget(boardId, boards);
					let snapshot;
					if (boards.length === 0) snapshot = {
						boardId: target,
						name: target,
						tickets: []
					};
					else try {
						snapshot = unwrap(await ctx.remote.taskboard.snapshot(sessionId, target));
					} catch {
						snapshot = {
							boardId: target,
							name: target,
							tickets: []
						};
					}
					return {
						boardId: target,
						boards,
						snapshot
					};
				};
				/** Refetch the active board's state and republish it. */
				const refresh = async () => {
					const boardId = current.boardId;
					try {
						const next = await fetchBoardState(boardId);
						if (current.boardId !== boardId) return;
						const active = next.boards.find((board) => board.boardId === next.boardId);
						current = {
							boardId: next.boardId,
							boards: next.boards,
							snapshot: next.snapshot,
							workspaceId: workspaceOf(sessionId),
							scope: active?.scope ?? "project",
							ownerSessionId: active?.ownerSessionId ?? null,
							masterAgentId: active?.masterAgentId ?? null,
							masterClaimedAt: active?.masterClaimedAt ?? null,
							masterExpiresAt: active?.masterExpiresAt ?? null
						};
					} catch {
						if (current.boardId === boardId && current.snapshot === null) current = {
							...current,
							snapshot: {
								boardId,
								name: boardId,
								tickets: []
							}
						};
					}
					publish();
				};
				/** Switch the active board and refetch both feeds. */
				const selectBoard = async (boardId) => {
					if (boardId === current.boardId) {
						refresh();
						return;
					}
					current = {
						...current,
						boardId
					};
					refresh();
				};
				/** Create one board from its display name and scope, then open it. */
				const createBoard = async (name, scope = "session") => {
					const request = {
						name,
						scope
					};
					const created = unwrap(await ctx.remote.taskboard.createBoard(sessionId, request));
					await selectBoard(created.boardId);
					return created;
				};
				/** Archive one board; archiving the active board falls back to default. */
				const archiveBoard = async (boardId) => {
					const archived = unwrap(await ctx.remote.taskboard.archiveBoard(sessionId, { boardId }));
					if (archived.boardId === current.boardId) await selectBoard("default");
					else refresh();
					return archived;
				};
				return {
					board: {
						getSnapshot: () => current,
						subscribe: (listener) => {
							listeners.add(listener);
							return () => {
								listeners.delete(listener);
							};
						}
					},
					refresh,
					selectBoard,
					createBoard,
					archiveBoard
				};
			};
			ctx.effect(() => ctx.remote.$on("taskboard/changed", () => {
				for (const source of sources.values()) source.refresh();
			}), "ui-taskboard: board changes");
			ctx.slots.inject("conversation.view", () => ctx.slots.register({
				name: "conversation.view",
				id: "taskboard",
				order: 20,
				locale: NS,
				label: () => t("view.taskboard"),
				store: createTaskboardStore(),
				inject: (sessionId) => {
					let source = sources.get(sessionId);
					if (source === void 0) {
						source = makeSource(sessionId);
						sources.set(sessionId, source);
						source.refresh();
					}
					return {
						create: async (request) => unwrap(await ctx.remote.taskboard.create(sessionId, request)),
						move: async (request) => unwrap(await ctx.remote.taskboard.move(sessionId, request)),
						edit: async (request) => unwrap(await ctx.remote.taskboard.edit(sessionId, request)),
						remove: async (request) => unwrap(await ctx.remote.taskboard.delete(sessionId, request)),
						requestReview: async (request) => unwrap(await ctx.remote.taskboard.requestReview(sessionId, request)),
						refresh: () => {
							source.refresh();
						},
						selectBoard: source.selectBoard,
						createBoard: source.createBoard,
						archiveBoard: source.archiveBoard,
						hooks: { board: source.board }
					};
				}
			}, TaskboardView));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.pickBoardTarget = pickBoardTarget;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map
/**
 * The modal questions the harness asks, in one place.
 *
 * Kept out of `app.ts` because the application is already the largest module and
 * because these have a hard requirement worth isolating: **every question must
 * settle**. A promise that never resolves wedges an agent turn, and the ways to
 * leak one are not obvious — an Escape, a system box, an aborted signal, a
 * second dialog opened over the first. So the settle-once rule lives in
 * {@link Dialog} and the callers here only ever await.
 *
 * The approval path is the one with real consequences. DSH fails *closed*: with
 * nobody answering, every gated tool call is denied and the model is told there
 * is no approval channel. That makes this a functional requirement rather than
 * a nicety, and it is why the four outcomes below are the harness's own
 * vocabulary rather than anything invented here.
 * @module dsh-tvision/app/questions
 */

import type { DialogSpec } from '../views/dialogs.ts'

/** The harness's closed approval vocabulary. */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** An approval request, as the waterfall delivers it. */
export interface ApprovalAsk {
  readonly toolName: string
  readonly reason?: string
  readonly signal?: AbortSignal
}

/** One structured question, as `ask_user_question` delivers it. */
export interface QuestionAsk {
  readonly id: string
  readonly question: string
  readonly header?: string
  readonly detail?: string
  readonly options?: readonly { label: string; description?: string }[]
  readonly multiSelect?: boolean
}

/** The answer shape `ask_user_question` expects back. */
export interface QuestionsAnswer {
  readonly answers: { id: string; selected: string[] }[]
}

/** The one thing this module needs from the application. */
export interface AskHost {
  /**
   * Put a modal question and wait for the answer.
   * @param spec - The question, detail, and choices.
   * @param signal - Optional lifetime; aborting dismisses.
   * @returns The chosen value, or undefined when dismissed.
   */
  ask(spec: DialogSpec, signal?: AbortSignal): Promise<string | undefined>
}

/** The sentinel a multi-select question uses for "I am finished choosing". */
const DONE = '\u0000done'
/** The sentinel a single-select question uses for "I do not want to answer". */
const CANCEL = '\u0000cancel'

/**
 * Build the approval dialog.
 * @param request - The tool and reason.
 * @returns The dialog specification.
 */
export function approvalSpec(request: ApprovalAsk): DialogSpec {
  const question = request.reason === undefined
    ? `Allow ${request.toolName} to run?`
    : `${request.toolName}: ${request.reason}`
  return {
    title: 'Approval required',
    question,
    detail: [
      'The agent asked to run a tool that needs your decision.',
      '',
      `tool: ${request.toolName}`,
      ...(request.reason === undefined ? [] : ['', `reason: ${request.reason}`]),
      '',
      'Y allows this call only. The grant is one-shot by design: the harness',
      'records the decision in the session log and asks again next time.',
      '',
      'N, Escape, or closing this window refuses the call, and the model is',
      'told it was denied.',
    ].join('\n'),
    letterKeys: true,
    choices: [
      {
        value: 'allow',
        label: 'Allow once',
        detail: 'Run this one call; ask again next time.',
      },
      {
        value: 'deny',
        label: 'Deny',
        detail: 'Refuse; the model is told the call was denied.',
        dangerous: true,
      },
    ],
  }
}

/**
 * Ask for an approval decision.
 * @param host - The application's modal hook.
 * @param request - The tool and reason.
 * @returns The harness's outcome.
 */
export async function askApproval(host: AskHost, request: ApprovalAsk): Promise<ApprovalOutcome> {
  // The signal can abort *while the dialog is up*, which is what the second
  // check exists for. Reading it through a helper keeps the compiler from
  // treating that read as unreachable after the first one.
  const signal = request.signal
  const aborted = (): boolean => signal?.aborted === true
  if (aborted()) return 'cancelled'
  const value = await host.ask(approvalSpec(request), signal)
  // An abort during the dialog is a withdrawal rather than a refusal, and the
  // harness records the two differently in its audit log.
  if (aborted()) return 'cancelled'
  if (value === 'allow') return 'allowed-once'
  if (value === 'deny') return 'rejected'
  return 'cancelled'
}

/**
 * Build the dialog for one question.
 *
 * A multi-select question is asked repeatedly — each answer toggles an option
 * and reopens the list with the chosen ones ticked and a `Done` row added — so
 * the widget layer needs no multi-select mode of its own.
 * @param question - The question.
 * @param chosen - Options chosen so far.
 * @returns The dialog specification.
 */
export function questionSpec(question: QuestionAsk, chosen: readonly string[]): DialogSpec {
  const choices: DialogSpec['choices'][number][] = (question.options ?? []).map(option => ({
    value: option.label,
    label: chosen.includes(option.label) ? `✓ ${option.label}` : option.label,
    ...(option.description === undefined ? {} : { detail: option.description }),
  }))
  if (question.multiSelect === true) {
    // A multi-select always has a way out: `Done` once something is ticked, and
    // on an optionless question immediately, because an unanswerable window is
    // worse than a trivial one.
    if (chosen.length > 0) {
      choices.push({ value: DONE, label: `Done (${chosen.length} chosen)`, isDefault: true })
    } else if (choices.length === 0) {
      choices.push({ value: DONE, label: 'Done', isDefault: true })
    }
  } else if (choices.length === 0) {
    // A free-form question with no options: the only useful answer is to
    // decline, and saying so is better than an empty window.
    choices.push({ value: CANCEL, label: 'No answer', dangerous: true })
  } else {
    choices.push({ value: CANCEL, label: 'Cancel', dangerous: true })
  }
  return {
    title: question.header ?? 'Question',
    question: question.question,
    ...(question.detail === undefined ? {} : { detail: question.detail }),
    choices,
  }
}

/**
 * Ask a batch of structured questions, in order.
 * @param host - The application's modal hook.
 * @param questions - The questions.
 * @returns The answer to hand back to the harness.
 */
export async function askQuestions(
  host: AskHost,
  questions: readonly QuestionAsk[],
): Promise<QuestionsAnswer> {
  const answers: { id: string; selected: string[] }[] = []
  for (const question of questions) {
    const chosen: string[] = []
    if (question.multiSelect === true) {
      // Repeated passes: each choice toggles and reopens until Done.
      for (;;) {
        const value = await host.ask(questionSpec(question, chosen))
        if (value === undefined || value === CANCEL || value === DONE) break
        const index = chosen.indexOf(value)
        if (index >= 0) chosen.splice(index, 1)
        else chosen.push(value)
      }
    } else {
      const value = await host.ask(questionSpec(question, chosen))
      if (value !== undefined && value !== CANCEL) chosen.push(value)
    }
    answers.push({ id: question.id, selected: chosen })
  }
  return { answers }
}

/** The sentinel values, exposed so the tests can assert on them. */
export const QUESTION_SENTINELS = Object.freeze({ done: DONE, cancel: CANCEL })

/**
 * Which tier an upload gets, and whether it has to pay first.
 *
 * Pure, because this is the billing decision: who gets the whole recording and who
 * gets the free first minutes. Inside a handler it needs a database and a running
 * model to exercise; out here every branch has a test.
 */

/**
 * @param {object} args
 * @param {'preview'|'full'|'auto'} args.asked
 * @param {boolean} args.paidAgent  holds a live x402 pass, so this call is paid
 * @param {boolean} args.hasUser    a session or API key resolved to an account
 * @param {boolean} args.canSpend   that account had the minutes this file costs
 * @param {number}  args.minutes    billable minutes of the whole file
 * @param {number}  args.previewSeconds  how much a preview transcribes
 * @param {number}  args.agentMaxMinutes the most one x402 call covers
 * @param {boolean} [args.freeForAll]    a private instance that charges nobody
 * @returns {{tier: 'preview'|'full', refuse: null | {status: number, reason: string}}}
 */
export function decideTier({
  asked,
  paidAgent,
  hasUser,
  canSpend,
  minutes,
  previewSeconds,
  agentMaxMinutes,
  freeForAll = false,
}) {
  if (asked === 'preview') return { tier: 'preview', refuse: null };
  // A private instance (FREE_FOR_ALL): the whole file, for anyone.
  if (freeForAll) return { tier: 'full', refuse: null };

  // A recording that fits inside the preview is the whole recording. Charging for
  // it, or calling it a preview, would both be wrong.
  if (minutes * 60 <= previewSeconds) return { tier: 'full', refuse: null };

  if (paidAgent) {
    if (minutes > agentMaxMinutes) {
      return {
        tier: 'preview',
        refuse: {
          status: 413,
          reason: `one x402 call covers up to ${agentMaxMinutes} minutes; this is ${minutes}`,
        },
      };
    }
    return { tier: 'full', refuse: null };
  }
  if (hasUser && canSpend) return { tier: 'full', refuse: null };

  /*
   * Could not do the whole file.
   *
   * Asked for it explicitly -> 402, always. Quietly transcribing three minutes of a
   * requested hour and answering 202 tells an API client nothing went wrong.
   * Asked for `auto` -> the preview is the honest answer: that is a browser saying
   * "whatever I am entitled to", and the page says what it got.
   */
  if (asked === 'full') {
    return {
      tier: 'preview',
      refuse: {
        status: 402,
        reason: hasUser
          ? `not enough minutes: this file needs ${minutes}`
          : 'the whole file needs minutes on an account or an x402 payment',
      },
    };
  }
  return { tier: 'preview', refuse: null };
}

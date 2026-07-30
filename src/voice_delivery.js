// One testable delivery boundary for every voice surface. A response may say "sent" only after the
// shared session input path accepted the message; all other outcomes are explicit and machine-readable.

function target(item) {
  return {
    status: 'unknown',
    sessionId: item?.sessionId || null,
    project: item?.project || item?.tool || 'the session',
  };
}

export async function deliverVoiceFeedback({
  item,
  reply,
  requestAlive = true,
  getSession,
  answeredElsewhere,
  deliverReply,
} = {}) {
  const delivery = target(item);
  if (!item) {
    delivery.status = 'missing';
    return { sent: false, say: 'That item is no longer available, so I did not send anything. Moving on.', delivery };
  }
  if (!requestAlive) {
    delivery.status = 'cancelled';
    return { sent: false, say: 'The conversation closed before delivery, so I did not send anything.', delivery };
  }
  const live = getSession(item.sessionId);
  if (!live || live.status === 'exited') {
    delivery.status = 'stopped';
    return { sent: false, say: 'That session has stopped, so I could not send it. You can resume it from the dashboard. Moving on.', delivery };
  }
  if (live.status !== 'waiting' && answeredElsewhere(item.sessionId, item.presentedAt)) {
    delivery.status = 'already-answered';
    return { sent: false, say: 'That item was already answered from somewhere else, so I did not send. Moving on.', delivery };
  }
  try {
    const message = String(reply?.message || '').trim();
    const result = await deliverReply(item.sessionId, message);
    if (result?.stopped || result?.missing) {
      delivery.status = result.stopped ? 'stopped' : 'missing';
      return { sent: false, say: 'That session has stopped, so I could not send it. You can resume it from the dashboard. Moving on.', delivery };
    }
    delivery.status = 'sent';
    delivery.length = message.length;
    return { sent: true, say: `Sent your feedback to ${delivery.project}. Moving on.`, delivery };
  } catch (error) {
    delivery.status = 'failed';
    delivery.error = String(error?.message || error || 'delivery failed').slice(0, 160);
    return { sent: false, say: "I couldn't deliver that feedback, so it still needs you. Moving on for now.", delivery };
  }
}

export function recoveryAttempt(state, exitKey, timestamp, windowMs) {
  const st = state && typeof state === 'object' ? state : {};
  const prior = Math.max(0, Number(st.exitRecoveryAttempt || 0));
  if (st.exitRecoveryKey === exitKey) return prior;
  const lastAt = Number(st.exitRecoveryLastAt || 0);
  const age = Number(timestamp) - lastAt;
  const chained = st.exitRecoveryResolved === false
    && lastAt > 0
    && age >= 0
    && age <= Number(windowMs);
  return chained ? prior : 0;
}

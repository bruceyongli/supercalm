const ARCH_RULE_RX = /\b(langgraph|n8n|workflow runtime|architecture doc|architecture upgrade|capability_contract|in-house graph|executor|template source|hermes|mcp servers?)\b/i;
const SAFETY_RULE_RX = /\b(deploy|production|worker|migration|r2|secret|coordinate|clobber|shared|app\.tsx|styles\.css|branch|merge)\b/i;
const ARCH_TASK_RX = /\b(langgraph|n8n|workflow|architecture|runtime|executor|hermes|capability_contract|mcp|template importer?)\b/i;

export function filterHardRulesForCurrentTask(rules = [], currentTask = null) {
  const list = Array.isArray(rules) ? rules : [];
  if (!currentTask?.staleDocOverride) return list;
  const text = [
    currentTask.currentWork,
    currentTask.latestOperatorWordsConsidered,
    currentTask.directOperatorIntent?.text,
    ...(currentTask.acceptanceGates || []),
  ].filter(Boolean).join('\n');
  if (ARCH_TASK_RX.test(text)) return list;
  return list.filter((rule) => !ARCH_RULE_RX.test(rule) || SAFETY_RULE_RX.test(rule));
}

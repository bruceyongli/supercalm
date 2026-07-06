import { isAbsolute, join, normalize, relative } from 'node:path';

export function confinedPath(root, requestPath) {
  const base = normalize(root);
  const target = normalize(join(base, requestPath));
  const rel = relative(base, target);
  if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) return target;
  return null;
}

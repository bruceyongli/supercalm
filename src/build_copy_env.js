// Command-scoped only: never preload a coding CLI, service, or the operator's shell.
const preload = new URL('./build_asset_copy.js', import.meta.url).href;
export function buildCopyEnvironment(source, env = process.env) {
  if (process.platform !== 'darwin' || env.AIOS_BUILD_FAST_COPY === '0' || /\/proxy(?:\/|$)/.test(source)) return { ...env };
  const options = env.NODE_OPTIONS || '';
  return { ...env, AIOS_BUILD_COPY_ROOT: source,
    NODE_OPTIONS: options.includes(preload) ? options : `${options} --import=${preload}`.trim() };
}

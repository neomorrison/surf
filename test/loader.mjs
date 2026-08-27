export function resolve(specifier, context, next) {
  if (specifier === 'three') return next(new URL('./three-stub.mjs', import.meta.url).href, context);
  return next(specifier, context);
}

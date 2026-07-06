/**
 * `xhr2` (the Node polyfill for `XMLHttpRequest`, required by grpc-web's
 * browser-oriented transport — see ../parrygg/client.ts) ships no types and
 * has no `@types/xhr2` package on npm. We only ever assign its default
 * export onto `global.XMLHttpRequest`, so a minimal ambient declaration is
 * enough — no need to model its full API surface.
 */
declare module 'xhr2' {
  const XMLHttpRequest: unknown;
  export default XMLHttpRequest;
}

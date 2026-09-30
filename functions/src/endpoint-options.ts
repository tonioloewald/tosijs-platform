/**
 * Options every HTTP endpoint is deployed with.
 *
 * `invoker: 'public'` — anyone may CALL the function; our own RBAC decides
 * what they may DO ("publicly invocable" is not "publicly authorized"). Set in
 * code, it is re-applied on EVERY deploy. The alternative, a one-off IAM
 * binding, is lost or never granted in practice — `stored` and `gen` both lost
 * theirs, and a host owner had to fix it in the Cloud console. Declaring it
 * here removes that step, and the need to know Cloud Run's permission model.
 *
 * endpoint-options.test.ts fails if an endpoint is declared without it.
 */
export const PUBLIC_ENDPOINT = { invoker: 'public' } as const

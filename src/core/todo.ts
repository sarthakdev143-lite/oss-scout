/** Placeholder used by contract stubs before a module is implemented. */
export function notImplemented(name: string): never {
  throw new Error(`${name} is not implemented yet`)
}

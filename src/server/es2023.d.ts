// The ported Paseo files use Array#findLast (ES2023, in Node since 18); this project's lib is ES2022.
interface Array<T> {
  findLast(predicate: (value: T, index: number, array: T[]) => unknown): T | undefined
}

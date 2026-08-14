// テストで使う Node 組み込みモジュールの型宣言。
//
// @types/node を入れれば済むが、この repo は Workers 向けで
// types に @cloudflare/workers-types だけを指定している。@types/node を混ぜると
// fetch / crypto / Request などのグローバルが Node 版で上書きされ、
// src 側の型が実際のランタイムと食い違う。
// 使うのは test と assert の数個だけなので、ここで宣言して依存を増やさない。

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  interface AssertStrict {
    /** 真であることを確認する（偽なら例外）。以降その値は非 null として扱える。 */
    ok(value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    rejects(
      fn: () => Promise<unknown>,
      expected?: RegExp | Error | ((err: unknown) => boolean),
      message?: string,
    ): Promise<void>;
  }
  const assert: AssertStrict;
  export default assert;
}

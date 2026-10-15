// Tests for running work concurrently while delivering results in order.
import { describe, expect, it } from "vitest";
import { forEachInOrder } from "./in-order.js";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("forEachInOrder", () => {
  it("delivers results in input order even when later items finish first", async () => {
    const delivered: number[] = [];
    await forEachInOrder(
      [30, 0, 10, 0],
      3,
      async (ms) => {
        await sleep(ms);
        return ms;
      },
      (result) => {
        delivered.push(result);
      },
    );
    expect(delivered).toEqual([30, 0, 10, 0]);
  });

  it("waits for an async handler before handing over the next result", async () => {
    const events: string[] = [];
    await forEachInOrder(
      ["a", "b"],
      2,
      (item) => Promise.resolve(item),
      async (item) => {
        events.push(`start ${item}`);
        await sleep(5);
        events.push(`end ${item}`);
      },
    );
    expect(events).toEqual(["start a", "end a", "start b", "end b"]);
  });

  it("never runs more than the given number of items at once", async () => {
    let running = 0;
    let peak = 0;
    await forEachInOrder(
      [1, 2, 3, 4, 5, 6],
      2,
      async () => {
        running += 1;
        peak = Math.max(peak, running);
        await sleep(1);
        running -= 1;
      },
      () => undefined,
    );
    expect(peak).toBe(2);
  });

  it("rethrows a failure when its turn comes, after earlier results", async () => {
    const delivered: string[] = [];
    const run = forEachInOrder(
      ["a", "boom", "c"],
      3,
      (item) =>
        item === "boom"
          ? Promise.reject(new Error("boom"))
          : Promise.resolve(item),
      (result) => {
        delivered.push(result);
      },
    );
    await expect(run).rejects.toThrow("boom");
    expect(delivered).toEqual(["a"]);
  });
});

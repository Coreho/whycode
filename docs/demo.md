# The first WhyCode review

Run `whycode demo` after following [the quickstart](../QUICKSTART.md).
It demonstrates a **prepared response** and **simulated acceptance**.
No model is called. This demonstrates the review
workflow, not measured generation quality.

## Original

```javascript
export async function loadWithCleanup(load, cleanup) {
  try {
    return await load();
  } finally {
    cleanup();
  }
}
```

The sample loads a value and then runs cleanup. The important consequence is
that a thrown cleanup error replaces the pending return value or error.

## Preview

The demo supplies a prepared comment plan to the real JavaScript adapter and
the normal CLI review pipeline. Formatting is disabled. The preview shows:

```diff
   } finally {
+    // If cleanup throws, its error replaces the load result or error.
     cleanup();
```

At this point the sample has not been changed. The token check establishes
preservation of the checked code tokens, not that the comment is true. The
meaning of the comment still needs review.

## Decision and result

The demo prints `y (simulated demo choice)` at the normal review prompt. It
then writes only its temporary sample and displays the resulting source. The
sample is removed at the end. A live `whycode fix` run asks **you** for the
decision; a live model may propose different comments or no changes.

Existing-comment corrections, when present in a live run, are separate
decisions after the new-comment batch. They are not part of this small sample.

## Your first real run

Configure your model access, then use `whycode fix <one-file> --no-format`.
On Windows PowerShell use `whycode.cmd`. Before accepting, ask:

1. Does this explanation match the behavior, including exceptions?
2. Does it tell me something useful beyond reading the statement itself?
3. Am I comfortable saving the displayed changes?

After acceptance, look for `Wrote <file>`, inspect the result, and run the
project's tests. Rejecting the proposal leaves that file's source unchanged.

// Risky Java constructs exercise valid comment placement and string verification.
import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;

@interface Tags {
  String[] value();
}

record Entry(String name, int quantity) {
  int doubled() {
    return quantity * 2;
  }
}

enum Mode {
  FAST,
  SAFE,
}

enum Operation {
  DOUBLE {
    @Override
    int apply(int value) {
      return value * 2;
    }
  };

  abstract int apply(int value);
}

/** Existing documentation remains ordinary block-comment text. */
@Tags({
  "orders",
  "verification",
})
class Verification {
  static final String MESSAGE = """
      Order summary:
      Customer "Ada" has // text, not a comment.
      Keep this text block line.
      """;
  static final String ESCAPED = "quote: \"; slash: \\; newline: \n; tab: \t";

  @Deprecated
  static int calculate(List<? extends Entry> entries, List<? super String> output) {
    Function<Entry, String> label = entry -> entry.name().trim();
    Function<String, String> normalize = String::toUpperCase;
    int[] weights = {
      1,
      // Keep this element separate when formatted.
      2,
      3,
    };
    Runnable reporter = new Runnable() {
      @Override
      public void run() {
        output.add(MESSAGE + ESCAPED);
      }
    };
    reporter.run();
    int total = 0;
    collect:
    for (Entry entry : entries) {
      for (int weight : weights) {
        if (weight == 1) {
          continue collect;
        }
        if (entry.quantity() < 0) {
          break collect;
        }
        total += entry.doubled() + weight;
      }
      output.add(normalize.apply(label.apply(entry)));
    }
    return switch (entries.size()) {
      case 0 -> 0;
      case 1 -> total;
      default -> {
        yield total + 1;
      }
    };
  }

  static List<String> report(List<Entry> entries) {
    List<String> output = new ArrayList<>();
    output.add(Integer.toString(calculate(entries, output)));
    return output;
  }
}

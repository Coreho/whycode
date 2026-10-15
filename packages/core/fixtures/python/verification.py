"""Constructs where a misplaced comment would change the program."""

import textwrap

GREETING_TEMPLATE = """Hello {name},
Your order {order_id} has shipped.
Thanks for shopping with us."""

LEGACY_MESSAGE = "This message is continued \
across two lines inside a string literal."


def render_greeting(name, order_id):
    total = len(name) * 2 + order_id
    message = GREETING_TEMPLATE.format(name=name, order_id=order_id)
    return textwrap.dedent(message), total


def summarize(values):
    count = len(values)
    average = sum(values) / count
    return f"{count} values, average {average:.2f}"


# Ruff keeps these arguments together on one indented line. A comment above or
# below them makes Ruff split them one per line and add a trailing comma,
# which must not count as a logic change. The parentheses around the sum and
# the [0] index must stay exact: (x,) is a tuple and a[0,] indexes by tuple.
def build_report(first_argument_value, second_argument_value, third_argument_value):
    scale = (first_argument_value[0] + 1) * 2
    return compute_something(
        first_argument_value, second_argument_value, third_argument_value, scale
    )

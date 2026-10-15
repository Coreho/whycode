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

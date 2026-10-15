// Constructs where a misplaced comment would change the program.
import { useState } from "react";

const RECEIPT_HEADER = `Receipt
=======
Thank you for your order.`;

const LEGACY_NOTE = "This note is continued \
across two lines inside a string literal.";

type Item = { id: string; label: string; price: number };

export function OrderSummary({ items }: { items: Item[] }) {
  const [expanded, setExpanded] = useState(false);
  const total = items.reduce((sum, item) => sum + item.price * 1.08, 0);
  const average = total / items.length;
  return (
    <section className="order-summary" data-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      <h2>{RECEIPT_HEADER}</h2>
      <p>
        Your order contains several items and the total below already includes sales tax for your region.
      </p>
      <ul>
        {items.map((item) => <li key={item.id}>{item.label}: {item.price.toFixed(2)} each, before any discounts</li>)}
      </ul>
      <strong>{average.toFixed(2)} {LEGACY_NOTE}</strong>
    </section>
  );
}

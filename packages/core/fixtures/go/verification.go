// Risky Go constructs exercise the logic-unchanged check and directive preservation.
//go:build cgo

package probes

/*
#define DOUBLE(value) \
    ((value) * 2)
typedef int number;
*/
import "C"

import (
    _ "embed"
    "strings"
)

const greeting = `Hello customer,
Your order has shipped.
Thanks for shopping with us.`

//go:generate echo regenerate fixtures
//go:embed verification.go
var source string

type Entry struct {
    Name string `json:"name" validate:"required"`
    Count int `json:"count"`
}

//go:noinline
func summarize(entries []Entry) string {
    total := len(entries) * 2
    names := []string{
        "receipt",
        "summary",
    }
retry:
    if total < 0 {
        total = 0
        goto retry
    }
collect:
    for _, entry := range entries {
        if entry.Count == 0 {
            break collect
        }
        names = append(names, entry.Name)
    }
    return strings.NewReplacer("receipt", "order").
        Replace(strings.Join(names, ", "))
}

func cgoDouble(value C.number) C.number {
    return value * 2
}

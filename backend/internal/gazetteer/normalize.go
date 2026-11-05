package gazetteer

import (
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// Normalize is shared by import and query. It preserves Han characters.
func Normalize(value string) string {
	var b strings.Builder
	for _, r := range norm.NFKD.String(value) {
		switch {
		case unicode.Is(unicode.Mn, r):
			continue
		case unicode.IsLetter(r) || unicode.IsNumber(r):
			b.WriteRune(unicode.ToLower(r))
		default:
			b.WriteByte(' ')
		}
	}
	return strings.Join(strings.Fields(b.String()), " ")
}

func hasHan(value string) bool {
	return strings.ContainsFunc(value, func(r rune) bool { return unicode.Is(unicode.Han, r) })
}

package auth

import (
	"strings"
	"testing"
)

// TestRenderOTPEmail guards against two classes of regression that
// html/template only surfaces at runtime: a malformed template string
// (caught at init by template.Must, but re-checked here so a CI run
// covers it without booting the whole server) and a field-name drift
// between the template action (`{{.OTP}}`) and the data struct
// (`otpEmailData.OTP`). Rename either without updating the other and
// this test fails — that is the whole point.
func TestRenderOTPEmail(t *testing.T) {
	const code = "123456"
	got, err := renderOTPEmail(code)
	if err != nil {
		t.Fatalf("renderOTPEmail returned error: %v", err)
	}
	if !strings.Contains(got, code) {
		t.Fatalf("rendered body missing OTP %q:\n%s", code, got)
	}
	// Guard against accidentally trimming the surrounding shell — any
	// of these disappearing means the template layout changed in a way
	// that would break mail client rendering.
	for _, want := range []string{
		"<!DOCTYPE html>",
		"Your verification code",
		"www.kuku.mom",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("rendered body missing marker %q", want)
		}
	}
}

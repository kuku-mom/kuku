package auth

import (
	"bytes"
	"html/template"
)

const otpEmailSubject = "Your kuku verification code"

const otpEmailTemplate = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Verification Code</title>
</head>
<body style="margin: 0; padding: 0; background-color: #ffffff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table role="presentation" style="width: 100%; border-collapse: collapse;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" style="max-width: 400px; width: 100%; border-collapse: collapse;">
          <!-- Logo -->
          <tr>
            <td align="center" style="padding-bottom: 32px;">
              <img src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMDgwIiBoZWlnaHQ9IjEwODAiIGZpbGw9Im5vbmUiIHZpZXdCb3g9IjAgMCAxMDgwIDEwODAiPjxwYXRoIGZpbGw9IiMxMjEyMTIiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSIzMCIgZD0iTTIyOC45NjcgMTA5LjQwN2MzMi4zMjctMS45MjcgNjkuNzM2IDMuMjA0IDEwOC4zODcgMTEuMTE3IDM4Ljc0NCA3LjkzMyA3OS45MDYgMTguOTI0IDExOS42MzcgMjkuMTU4IDM5Ljk5OSAxMC4zMDIgNzguNTcyIDE5Ljg0NSAxMTMuMTM1IDI1LjI3MiAzNC43NzUgNS40NjEgNjYuMDU5IDguMjAyIDk0LjgyIDEwLjQgMjguNTQ2IDIuMTgxIDU1LjE5NiAzLjg1OCA3OS42MzggNy4yMDkgNDkuNjczIDYuODEyIDkyLjQ1MSAyMC44MDMgMTMyLjEyMyA2MS4yODcgNzguMTk4IDc5Ljc5NyA4NS43NSAyMDQuNyA3MS4zNzkgMzEwLjgzMi0xNC45OTMgMTEwLjcyMy03MC4xMDcgMTU3LjgyMy0xNDIuMjY2IDIzNS4zNDQtMzUuNTcgMzguMjE0LTY4Ljk3NiA3OS4wNjItMTA1LjA2MyAxMTAuMzEzLTM2Ljc5NSAzMS44NjQtNzguMTkzIDU1LjU2Mi0xMzEuNzU5IDU5Ljg1OC0xMDQuNzc1IDguNDAzLTIxMi41MTItNDkuOTU2LTI3OS4zOTctMTMxLjI3MS0zNC45MjktNDIuNDY0LTQyLjUwMi03OC43NDgtNDUuMDYxLTEyMC43MTQtMi41MjMtNDEuMzgzLS4zNzQtODYuMjc1LTE0LjMzMi0xNTIuNDQ3LTYuODgzLTMyLjYzLTE5LjUzMS02OS41NjItMzMuOTgzLTEwOC4zOTUtMTQuMjk0LTM4LjQwNi0zMC40ODQtNzguOTk4LTQzLjYwNC0xMTcuMjg0LTEzLjEzMi0zOC4zMjItMjMuNzU4LTc1Ljg4Mi0yNi43NjMtMTA5LjA1My0yLjk4OC0zMi45ODcgMS4zMTYtNjQuNDMgMjEuMzctODcuNTg5IDE5LjkwOS0yMi45OTEgNDkuNDY4LTMyLjExMyA4MS43MzktMzQuMDM3WiIvPjxjaXJjbGUgY3g9IjM1NS41IiBjeT0iNDAyLjUiIHI9IjExMS40NDciIGZpbGw9IiNmZmYiIHN0cm9rZT0iIzEyMTIxMiIgc3Ryb2tlLXdpZHRoPSIyNC4xMDUiLz48cGF0aCBmaWxsPSIjZmZmIiBzdHJva2U9IiMxMjEyMTIiIHN0cm9rZS13aWR0aD0iMjQuMTA1IiBkPSJNNTEzIDMyNC4wNTNjNjEuODczIDAgMTExLjk0NyA0OS45NDIgMTExLjk0NyAxMTEuNDQ3UzU3NC44NzMgNTQ2Ljk0NyA1MTMgNTQ2Ljk0NyA0MDEuMDUzIDQ5Ny4wMDUgNDAxLjA1MyA0MzUuNSA0NTEuMTI3IDMyNC4wNTMgNTEzIDMyNC4wNTNaIi8+PHBhdGggZmlsbD0iIzEyMTIxMiIgc3Ryb2tlPSIjMTIxMjEyIiBzdHJva2Utd2lkdGg9IjEuMjA1IiBkPSJNMzU2IDMyMC42MDNjMjAuNjQ3IDAgMzcuMzk3IDE2Ljk1OSAzNy4zOTcgMzcuODk3cy0xNi43NSAzNy44OTctMzcuMzk3IDM3Ljg5Ny0zNy4zOTctMTYuOTU5LTM3LjM5Ny0zNy44OTcgMTYuNzUtMzcuODk3IDM3LjM5Ny0zNy44OTdabTE1NyAzOGMyMS4yMTQgMCAzOC4zOTcgMTYuOTc0IDM4LjM5NyAzNy44OTdTNTM0LjIxNCA0MzQuMzk3IDUxMyA0MzQuMzk3cy0zOC4zOTctMTYuOTc0LTM4LjM5Ny0zNy44OTcgMTcuMTgzLTM3Ljg5NyAzOC4zOTctMzcuODk3WiIvPjxyZWN0IHdpZHRoPSIyMTMuMTk1IiBoZWlnaHQ9Ijc4Ljc0MiIgeD0iMzEwLjc2OCIgeT0iNTc1LjY2NyIgZmlsbD0iIzAwMCIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjMwIiByeD0iMzkuMzcxIiB0cmFuc2Zvcm09InJvdGF0ZSg3LjE3NyAzMTAuNzY4IDU3NS42NjcpIi8+PGNpcmNsZSBjeD0iNTQwIiBjeT0iNTQxIiByPSI5IiBmaWxsPSIjZmZmIi8+PC9zdmc+" alt="kuku" style="height: 48px; width: auto;" />
            </td>
          </tr>

          <!-- Title -->
          <tr>
            <td align="center" style="padding-bottom: 8px;">
              <h1 style="margin: 0; font-size: 20px; font-weight: 500; color: #000000;">Your verification code</h1>
            </td>
          </tr>

          <!-- Subtitle -->
          <tr>
            <td align="center" style="padding-bottom: 32px;">
              <p style="margin: 0; font-size: 14px; color: #6b7280;">Enter this code to sign in to kuku</p>
            </td>
          </tr>

          <!-- OTP Code -->
          <tr>
            <td align="center" style="padding-bottom: 32px;">
              <div style="display: inline-block; background-color: #f3f4f6; border-radius: 8px; padding: 16px 32px;">
                <span style="font-size: 32px; font-weight: 500; letter-spacing: 8px; color: #000000;">{{.OTP}}</span>
              </div>
            </td>
          </tr>

          <!-- Expiry Notice -->
          <tr>
            <td align="center" style="padding-bottom: 32px;">
              <p style="margin: 0; font-size: 14px; color: #6b7280;">This code expires in 10 minutes.</p>
            </td>
          </tr>

          <!-- Ignore Notice -->
          <tr>
            <td align="center" style="padding-bottom: 48px;">
              <p style="margin: 0; font-size: 12px; color: #9ca3af;">If you didn't request this code, you can safely ignore this email.</p>
            </td>
          </tr>

          <!-- Divider -->
          <tr>
            <td style="padding-bottom: 24px;">
              <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 0;">
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center">
              <p style="margin: 0; font-size: 12px; color: #9ca3af;">kuku | <a href="https://www.kuku.mom" style="color: #6b7280; text-decoration: none;">www.kuku.mom</a></p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`

type otpEmailData struct {
	OTP string
}

var otpTmpl = template.Must(template.New("otp").Parse(otpEmailTemplate))

func renderOTPEmail(otp string) (string, error) {
	var buf bytes.Buffer
	if err := otpTmpl.Execute(&buf, otpEmailData{OTP: otp}); err != nil {
		return "", err
	}
	return buf.String(), nil
}

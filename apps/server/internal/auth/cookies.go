package auth

import "net/http"

const (
	AccessTokenName    = "access_token"
	RefreshTokenName   = "refresh_token"
	EmailAuthFlowName  = "email_auth_flow"
	AccessTokenMaxAge  = 15 * 60
	RefreshTokenMaxAge = 30 * 24 * 60 * 60
	EmailFlowMaxAge    = 10 * 60
)

func AddAuthCookies(header http.Header, accessToken, refreshToken string, secure bool) {
	header.Add("Set-Cookie", (&http.Cookie{
		Name:     AccessTokenName,
		Value:    accessToken,
		Path:     "/",
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   AccessTokenMaxAge,
	}).String())
	header.Add("Set-Cookie", (&http.Cookie{
		Name:     RefreshTokenName,
		Value:    refreshToken,
		Path:     "/",
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   RefreshTokenMaxAge,
	}).String())
}

func AddClearAuthCookies(header http.Header, secure bool) {
	for _, name := range []string{AccessTokenName, RefreshTokenName} {
		header.Add("Set-Cookie", (&http.Cookie{
			Name:     name,
			Value:    "",
			Path:     "/",
			HttpOnly: true,
			Secure:   secure,
			SameSite: http.SameSiteLaxMode,
			MaxAge:   -1,
		}).String())
	}
}

func AddEmailFlowCookie(header http.Header, flow string, secure bool) {
	header.Add("Set-Cookie", (&http.Cookie{
		Name:     EmailAuthFlowName,
		Value:    flow,
		Path:     "/",
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   EmailFlowMaxAge,
	}).String())
}

func AddClearEmailFlowCookie(header http.Header, secure bool) {
	header.Add("Set-Cookie", (&http.Cookie{
		Name:     EmailAuthFlowName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	}).String())
}

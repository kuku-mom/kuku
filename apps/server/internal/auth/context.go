package auth

import (
	"context"
	"errors"

	"github.com/google/uuid"
)

type contextKey string

const (
	userIDKey    contextKey = "user_id"
	sessionIDKey contextKey = "session_id"
)

func WithAuth(ctx context.Context, userID, sessionID uuid.UUID) context.Context {
	ctx = context.WithValue(ctx, userIDKey, userID)
	return context.WithValue(ctx, sessionIDKey, sessionID)
}

func FromContext(ctx context.Context) (uuid.UUID, uuid.UUID, error) {
	userID, ok := ctx.Value(userIDKey).(uuid.UUID)
	if !ok || userID == uuid.Nil {
		return uuid.Nil, uuid.Nil, errors.New("user id not found in context")
	}
	sessionID, ok := ctx.Value(sessionIDKey).(uuid.UUID)
	if !ok || sessionID == uuid.Nil {
		return uuid.Nil, uuid.Nil, errors.New("session id not found in context")
	}
	return userID, sessionID, nil
}

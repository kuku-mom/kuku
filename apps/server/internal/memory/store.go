package memory

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Store struct{ Pool *pgxpool.Pool }
type Principal struct {
	User     uuid.UUID
	Client   string
	Scopes   []string
	CanWrite bool
	Grant    uuid.UUID
}

func (p Principal) allows(scope string) bool {
	for _, s := range p.Scopes {
		if s == scope {
			return true
		}
	}
	return false
}
func (s Store) Read(ctx context.Context, p Principal, id string, management bool) (Memory, error) {
	var m Memory
	var data []byte
	err := s.Pool.QueryRow(ctx, `SELECT data FROM kuku.memories WHERE user_id=$1 AND id=$2 AND scope=ANY($3) AND ($4 OR (shared AND data->>'status'='active' AND ((data->>'expires_at') IS NULL OR (data->>'expires_at')::timestamptz>now())))`, p.User, id, p.Scopes, management).Scan(&data)
	if err != nil {
		return m, errors.New("memory not found")
	}
	err = json.Unmarshal(data, &m)
	return m, err
}
func (s Store) Search(ctx context.Context, p Principal, q Query) ([]Memory, error) {
	if len([]rune(q.Query)) > 500 {
		return nil, errors.New("query is too long")
	}
	if q.Scope != "" && !p.allows(q.Scope) {
		return nil, errors.New("scope is not authorized")
	}
	if q.Limit < 1 {
		q.Limit = 10
	}
	if q.Limit > 50 {
		q.Limit = 50
	}
	rows, err := s.Pool.Query(ctx, `SELECT data FROM kuku.memories WHERE user_id=$1 AND scope=ANY($2) AND ($3='' OR scope=$3) AND shared AND data->>'status'='active' AND ((data->>'expires_at') IS NULL OR (data->>'expires_at')::timestamptz>now()) AND ($4='' OR search @@ plainto_tsquery('simple',$4) OR strpos(lower(data->>'title'),lower($4))>0 OR strpos(lower(data->>'body'),lower($4))>0) ORDER BY ts_rank(search,plainto_tsquery('simple',$4)) DESC,data->>'updated_at' DESC LIMIT $5`, p.User, p.Scopes, q.Scope, q.Query, q.Limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []Memory{}
	for rows.Next() {
		var data []byte
		var m Memory
		if err = rows.Scan(&data); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(data, &m); err != nil {
			return nil, err
		}
		result = append(result, m)
	}
	return result, rows.Err()
}

// mutate serializes the user's journal so a cursor cannot skip a lower sequence
// committed after a higher sequence. It also serializes idempotency and CAS.
func (s Store) mutate(ctx context.Context, p Principal, requestID, fingerprint string, build func(pgx.Tx, *Memory) (Memory, string, error)) (map[string]any, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, p.User.String()); err != nil {
		return nil, err
	}
	var previous string
	var receipt []byte
	err = tx.QueryRow(ctx, `SELECT fingerprint,result FROM kuku.memory_receipts WHERE user_id=$1 AND client=$2 AND request_id=$3`, p.User, p.Client, requestID).Scan(&previous, &receipt)
	if err == nil {
		if previous != fingerprint {
			return nil, errors.New("request ID was already used with different content")
		}
		var result map[string]any
		err = json.Unmarshal(receipt, &result)
		return result, err
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	next, status, err := build(tx, nil)
	if err != nil {
		return nil, err
	}
	var before *Memory
	var data []byte
	err = tx.QueryRow(ctx, `SELECT data FROM kuku.memories WHERE user_id=$1 AND id=$2 FOR UPDATE`, p.User, next.ID).Scan(&data)
	if err == nil {
		before = &Memory{}
		if err = json.Unmarshal(data, before); err != nil {
			return nil, err
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	next, status, err = build(tx, before)
	if err != nil {
		return nil, err
	}
	result := map[string]any{"status": status, "id": next.ID, "version": next.Version}
	if status == "conflict" {
		if before != nil && p.allows(before.Scope) {
			result["memory"] = before
		}
		return result, nil
	}
	if status == "committed" {
		if _, err = tx.Exec(ctx, `INSERT INTO kuku.memories(user_id,id,scope,version,data,shared) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,id) DO UPDATE SET version=excluded.version,data=excluded.data,shared=excluded.shared`, p.User, next.ID, next.Scope, next.Version, encode(next), next.Shared); err != nil {
			return nil, err
		}
		result["memory"] = next
	}
	var beforeData any
	if before != nil {
		beforeData = encode(before)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO kuku.memory_changes(user_id,id,client,before_data,after_data) VALUES($1,$2,$3,$4,$5)`, p.User, next.ID, p.Client, beforeData, encode(next)); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO kuku.memory_receipts VALUES($1,$2,$3,$4,$5)`, p.User, p.Client, requestID, fingerprint, encode(result)); err != nil {
		return nil, err
	}
	return result, tx.Commit(ctx)
}
func (s Store) Remember(ctx context.Context, p Principal, r Remember) (map[string]any, error) {
	if err := validate(r); err != nil {
		return nil, err
	}
	if !p.CanWrite || !p.allows(r.Scope) {
		return nil, errors.New("write scope is not authorized")
	}
	var auto bool
	if err := s.Pool.QueryRow(ctx, `SELECT auto_save FROM kuku.memory_scopes WHERE user_id=$1 AND name=$2`, p.User, r.Scope).Scan(&auto); err != nil {
		return nil, errors.New("scope is not configured")
	}
	id := "mem_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if r.ID != nil {
		id = *r.ID
	}
	resolved, ambiguous := false, false
	return s.mutate(ctx, p, r.RequestID, hash(string(encode(r))), func(tx pgx.Tx, before *Memory) (Memory, string, error) {
		if !resolved {
			resolved = true
			if r.ID == nil {
				var existing string
				err := tx.QueryRow(ctx, `SELECT id FROM kuku.memories WHERE user_id=$1 AND scope=$2 AND shared AND data->>'status'='active' AND lower(data->>'title')=lower($3) ORDER BY data->>'updated_at' DESC LIMIT 1`, p.User, r.Scope, r.Title).Scan(&existing)
				if err == nil {
					id = existing
					ambiguous = true
				} else if !errors.Is(err, pgx.ErrNoRows) {
					return Memory{}, "", err
				}
			}
		}
		stamp := time.Now().UTC().Format(time.RFC3339Nano)
		key := hash(p.Client + ":" + r.RequestID)[:32]
		m := Memory{ID: id, Scope: r.Scope, Client: p.Client, Title: r.Title, Body: r.Body, Kind: r.Kind, Status: "active", Tags: r.Tags, Sources: r.Sources, Version: 1, ExpiresAt: r.ExpiresAt, CreatedAt: stamp, UpdatedAt: stamp, ProposalID: "prop_" + key, DecisionDocument: "Knowledge/decisions/doc_" + key + ".md", Shared: true}
		if m.Tags == nil {
			m.Tags = []string{}
		}
		if m.Sources == nil {
			m.Sources = []Source{}
		}
		if before != nil {
			if !before.Shared || before.Status == "deleted" || before.Scope != r.Scope || r.ID != nil && (r.ExpectedVersion == nil || *r.ExpectedVersion != before.Version) {
				return m, "conflict", nil
			}
			if ambiguous && strings.TrimSpace(before.Body) == strings.TrimSpace(r.Body) && ((before.ExpiresAt == nil && r.ExpiresAt == nil) || (before.ExpiresAt != nil && r.ExpiresAt != nil && *before.ExpiresAt == *r.ExpiresAt)) {
				return *before, "committed", nil
			}
			m.Version = before.Version + 1
			m.CreatedAt = before.CreatedAt
			m.Supersedes = &before.ID
		} else if r.ID != nil && r.ExpectedVersion != nil {
			return m, "conflict", nil
		}
		if !auto || ambiguous {
			m.Status = "pending"
			return m, "proposed", nil
		}
		return m, "committed", nil
	})
}

type Publication struct {
	ID              string `json:"id"`
	ExpectedVersion int64  `json:"expected_version"`
	Memory          Memory `json:"memory"`
	RequestID       string `json:"request_id"`
}

func (s Store) Publish(ctx context.Context, p Principal, r Publication) (map[string]any, error) {
	m := r.Memory
	if r.ID != m.ID || !identifier.MatchString(m.ID) || !strings.HasPrefix(m.ID, "mem_") || !p.allows(m.Scope) || !p.CanWrite || r.ExpectedVersion < 0 {
		return nil, errors.New("invalid publication")
	}
	candidate := Remember{RequestID: r.RequestID, Scope: m.Scope, Title: m.Title, Body: m.Body, Kind: m.Kind, Tags: m.Tags, Sources: m.Sources}
	if err := validate(candidate); err != nil {
		return nil, err
	}
	if m.Status != "active" && m.Status != "archived" && m.Status != "deleted" && m.Status != "superseded" {
		return nil, errors.New("invalid status")
	}
	if m.ExpiresAt != nil {
		if _, err := time.Parse(time.RFC3339, *m.ExpiresAt); err != nil {
			return nil, errors.New("invalid expiry")
		}
	}
	return s.mutate(ctx, p, r.RequestID, hash(string(encode(r))), func(_ pgx.Tx, before *Memory) (Memory, string, error) {
		if before == nil && r.ExpectedVersion != 0 {
			return m, "conflict", nil
		}
		if before != nil && (before.Version != r.ExpectedVersion || before.Scope != m.Scope || before.Status == "deleted" && m.Status != "deleted" && (m.RestoredFrom == nil || *m.RestoredFrom != before.Version)) {
			return m, "conflict", nil
		}
		if m.Version < r.ExpectedVersion+1 {
			m.Version = r.ExpectedVersion + 1
		}
		m.Client = p.Client
		m.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
		if before != nil {
			m.CreatedAt = before.CreatedAt
		} else {
			m.CreatedAt = m.UpdatedAt
		}
		return m, "committed", nil
	})
}
func (s Store) Changes(ctx context.Context, p Principal, cursor int64) (map[string]any, error) {
	rows, err := s.Pool.Query(ctx, `SELECT seq,after_data FROM kuku.memory_changes WHERE user_id=$1 AND seq>$2 ORDER BY seq LIMIT 200`, p.User, cursor)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	records := []Memory{}
	proposals := []Memory{}
	for rows.Next() {
		var seq int64
		var data []byte
		if err = rows.Scan(&seq, &data); err != nil {
			return nil, err
		}
		var m Memory
		if err = json.Unmarshal(data, &m); err != nil {
			return nil, err
		}
		cursor = seq
		if m.Status != "pending" {
			records = append(records, m)
		} else {
			proposals = append(proposals, m)
		}
	}
	return map[string]any{"memories": records, "proposals": proposals, "cursor": fmt.Sprint(cursor)}, rows.Err()
}

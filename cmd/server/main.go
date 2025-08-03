package main

import (
	"bytes"
	"encoding/gob"
	"encoding/json"
	"flag"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/ansarctica/nuddle/internal/autoscheduler"
	"github.com/ansarctica/nuddle/internal/types"
)

var (
	addr       = flag.String("addr", ":8080", "HTTP listen address")
	coursesGOB = flag.String("courses", "data/courses.gob", "path to courses.gob")
)

var (
	mu         sync.RWMutex
	allCourses []types.Course
	nameList   []string
	lowerIndex map[string]int
)

func init() {
	logDir := filepath.Join(".", "logs")
	_ = os.MkdirAll(logDir, 0o755)
	logPath := filepath.Join(logDir, "app.log")
	f, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err == nil {
		log.SetOutput(f)
		log.SetFlags(log.Ldate | log.Ltime | log.Lmicroseconds | log.Lshortfile)
	} else {
		log.Printf("failed to open log file: %v", err)
	}
}

func main() {
	flag.Parse()

	if err := loadCourses(*coursesGOB); err != nil {
		log.Fatalf("load %s: %v", *coursesGOB, err)
	}
	log.Printf("We have loaded %d courses!", lenCurrent())

	mux := http.NewServeMux()

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		http.ServeFile(w, r, filepath.Join("static", "index.html"))
	})

	staticFs := http.FileServer(http.Dir(filepath.Join("static")))
	mux.Handle("/static/", withCacheHeaders(http.StripPrefix("/static/", staticFs)))

	mux.HandleFunc("/api/courses/names", handleNames)
	mux.HandleFunc("/api/courses/lookup", handleLookup)
	mux.HandleFunc("/api/autoschedule", handleSolve)

	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	log.Printf("listening on %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, mux))
}

func loadCourses(path string) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}

	gob.Register(types.Course{})
	gob.Register(types.Session{})
	gob.Register([]types.Course{})
	gob.Register([]types.Session{})
	gob.Register(map[string][]int{})

	var list []types.Course
	dec := gob.NewDecoder(bytes.NewReader(b))
	if err := dec.Decode(&list); err != nil {
		return err
	}

	mu.Lock()
	defer mu.Unlock()

	allCourses = list
	nameList = make([]string, 0, len(allCourses))
	lowerIndex = make(map[string]int, len(allCourses))
	for i, c := range allCourses {
		nameList = append(nameList, c.COURSE_NAME)
		lowerIndex[strings.ToLower(c.COURSE_NAME)] = i
	}
	return nil
}

func lenCurrent() int {
	mu.RLock()
	defer mu.RUnlock()
	return len(allCourses)
}

func handleNames(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "GET only", http.StatusMethodNotAllowed)
		return
	}
	mu.RLock()
	defer mu.RUnlock()
	writeJSON(w, nameList)
}

func handleLookup(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "GET only", http.StatusMethodNotAllowed)
		return
	}

	q := strings.TrimSpace(r.URL.Query().Get("name"))
	if q == "" {
		writeJSON(w, []types.Course{})
		return
	}
	lq := strings.ToLower(q)

	mu.RLock()
	defer mu.RUnlock()

	if idx, ok := lowerIndex[lq]; ok {
		writeJSON(w, []types.Course{allCourses[idx]})
		return
	}
	for i, c := range allCourses {
		if strings.HasPrefix(strings.ToLower(c.COURSE_NAME), lq) {
			writeJSON(w, []types.Course{allCourses[i]})
			return
		}
	}
	for i, c := range allCourses {
		if strings.Contains(strings.ToLower(c.COURSE_NAME), lq) {
			writeJSON(w, []types.Course{allCourses[i]})
			return
		}
	}
	writeJSON(w, []types.Course{})
}

func handleSolve(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	raw, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "read body error", http.StatusBadRequest)
		return
	}
	defer r.Body.Close()

	var req autoscheduler.Request
	if err := json.Unmarshal(raw, &req); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}

	resp, _ := autoscheduler.Solve(&req)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

func withCacheHeaders(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		h.ServeHTTP(w, r)
	})
}

func ioReadAll(r *http.Request) ([]byte, error) {
	defer r.Body.Close()
	const max = 8 << 20
	return ioNopLimitReadAll(r.Body, max)
}

func ioNopLimitReadAll(rc ioReadCloser, max int64) ([]byte, error) {
	var b []byte
	var n int64
	buf := make([]byte, 32<<10)
	for {
		if n >= max {
			return nil, http.ErrContentLength
		}
		k, err := rc.Read(buf)
		if k > 0 {
			if n+int64(k) > max {
				return nil, http.ErrContentLength
			}
			b = append(b, buf[:k]...)
			n += int64(k)
		}
		if err != nil {
			if err == EOF {
				return b, nil
			}
			return nil, err
		}
	}
}

type ioReadCloser interface {
	Read([]byte) (int, error)
	Close() error
}

var EOF = &eofError{}

type eofError struct{}

func (*eofError) Error() string { return "EOF" }

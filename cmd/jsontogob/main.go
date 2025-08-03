package main

import (
	"bytes"
	"encoding/gob"
	"encoding/json"
	"flag"
	"log"
	"os"
	"path/filepath"

	"github.com/ansarctica/nuddle/internal/types"
)

func main() {
	in := flag.String("in", "data/courses.gob.json", "input JSON file")
	out := flag.String("out", "data/courses.gob", "output GOB file")
	strip := flag.Bool("strip", false, "drop sessions with TIME_RELEVANCE==0")
	flag.Parse()

	raw, err := os.ReadFile(*in)
	if err != nil {
		log.Fatalf("read %s: %v", *in, err)
	}
	var courses []types.Course
	if err := json.Unmarshal(raw, &courses); err != nil {
		log.Fatalf("json unmarshal: %v", err)
	}

	for i := range courses {
		courses[i].BuildTypeIndex(*strip)
	}

	var buf bytes.Buffer
	if err := gob.NewEncoder(&buf).Encode(courses); err != nil {
		log.Fatalf("gob encode: %v", err)
	}

	tmp := *out + ".tmp"
	if err := os.MkdirAll(filepath.Dir(*out), 0o755); err != nil {
		log.Fatalf("mkdir %s: %v", filepath.Dir(*out), err)
	}
	if err := os.WriteFile(tmp, buf.Bytes(), 0o644); err != nil {
		log.Fatalf("write tmp: %v", err)
	}
	if err := os.Rename(tmp, *out); err != nil {
		log.Fatalf("rename tmp->out: %v", err)
	}

	log.Printf("Wrote %d courses to %s", len(courses), *out)
}

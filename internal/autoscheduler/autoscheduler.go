package autoscheduler

import (
	"encoding/base64"
	"errors"
	"math"
	"sort"
)

const (
	days        = 6
	slotsPerDay = 32
	totalSlots  = days * slotsPerDay
	slotMin     = 30

	maxPlans = 50
)

type SessReq struct {
	Index   int    `json:"index"`
	BitsB64 string `json:"bitsB64"`
}

type TypeReq struct {
	Code            string    `json:"code"`
	PinnedIndex     *int      `json:"pinnedIndex"`
	AttendImportant bool      `json:"attendImportant"`
	Sessions        []SessReq `json:"sessions"`
}

type CourseReq struct {
	Key   string    `json:"key"`
	Name  string    `json:"name"`
	Types []TypeReq `json:"types"`
}

type Request struct {
	BusyBitsB64 string      `json:"busyBitsB64"`
	Courses     []CourseReq `json:"courses"`
}

type Assignment struct {
	CourseKey    string `json:"courseKey"`
	TypeCode     string `json:"typeCode"`
	SessionIndex int    `json:"sessionIndex"`
}

type Summary struct {
	BusyOverlapMin int `json:"busyOverlapMin"`
	GapMin         int `json:"gapMin"`
}

type Plan struct {
	Assignments []Assignment `json:"assignments"`
	Summary     Summary      `json:"summary"`
}

type SolveResponse struct {
	OK         bool   `json:"ok"`
	Message    string `json:"message,omitempty"`
	ChosenPlan *Plan  `json:"chosenPlan,omitempty"`
	AllOptimal []Plan `json:"allOptimal,omitempty"`
}

func Solve(req *Request) (*SolveResponse, error) {
	busyMask, err := bitsFromB64(req.BusyBitsB64)
	if err != nil {
		return &SolveResponse{OK: false, Message: "bad busy bits"}, nil
	}

	type typeInfo struct {
		code            string
		attendImportant bool
		pinned          *int
		sessMasks       [][days]uint32
		sessIdx         []int
	}
	type courseInfo struct {
		key   string
		name  string
		types []typeInfo
	}
	var courses []courseInfo

	for _, c := range req.Courses {
		ci := courseInfo{key: c.Key, name: c.Name}
		for _, t := range c.Types {
			ti := typeInfo{
				code:            t.Code,
				attendImportant: t.AttendImportant,
			}
			if t.PinnedIndex != nil {
				cp := *t.PinnedIndex
				ti.pinned = &cp
			}
			for _, s := range t.Sessions {
				if s.BitsB64 == "" {
					continue
				}
				m, err := bitsFromB64(s.BitsB64)
				if err != nil {
					continue
				}
				ti.sessMasks = append(ti.sessMasks, m)
				ti.sessIdx = append(ti.sessIdx, s.Index)
			}
			if len(ti.sessMasks) > 0 {
				ci.types = append(ci.types, ti)
			}
		}
		if len(ci.types) > 0 {
			courses = append(courses, ci)
		}
	}
	if len(courses) == 0 {
		return &SolveResponse{OK: false, Message: "no course types to schedule"}, nil
	}

	bestBusy := math.MaxInt32
	bestGap := math.MaxInt32
	var bestPlans []Plan

	var chosenAll [days]uint32
	var chosenAtt [days]uint32
	var chosenUn [days]uint32
	var picks []Assignment

	var dfs func(ci, ti int)
	next := func(ci, ti int) (int, int, bool) {
		ti++
		if ti >= len(courses[ci].types) {
			ci++
			ti = 0
		}
		return ci, ti, ci >= len(courses)
	}

	dfs = func(ci, ti int) {
		if ci >= len(courses) {

			busyMin := overlapMinutes(chosenAll, busyMask)
			gapMin := computeGapBetweenAttendedWithFallback(chosenAtt, chosenUn, busyMask, chosenAll)

			better := false
			if busyMin < bestBusy {
				better = true
			} else if busyMin == bestBusy && gapMin < bestGap {
				better = true
			}

			if better {
				bestBusy = busyMin
				bestGap = gapMin
				bestPlans = bestPlans[:0]
			}
			if busyMin == bestBusy && gapMin == bestGap {
				if len(bestPlans) < maxPlans {
					p := Plan{
						Assignments: append([]Assignment(nil), picks...),
						Summary: Summary{
							BusyOverlapMin: busyMin,
							GapMin:         gapMin,
						},
					}
					bestPlans = append(bestPlans, p)
				}
			}
			return
		}

		crs := courses[ci]
		typ := crs.types[ti]

		cands := make([]int, 0, len(typ.sessMasks))
		for k := range typ.sessMasks {
			if typ.pinned != nil && typ.sessIdx[k] != *typ.pinned {
				continue
			}
			cands = append(cands, k)
		}
		if len(cands) == 0 {
			return
		}

		sort.Slice(cands, func(i, j int) bool {
			return popcntMask(typ.sessMasks[cands[i]]) < popcntMask(typ.sessMasks[cands[j]])
		})

		for _, ix := range cands {
			m := typ.sessMasks[ix]

			if overlaps(m, chosenAll) {
				continue
			}

			prevAll := chosenAll
			prevAtt := chosenAtt
			prevUn := chosenUn

			orInto(&chosenAll, m)
			if typ.attendImportant {
				orInto(&chosenAtt, m)
			} else {
				orInto(&chosenUn, m)
			}

			picks = append(picks, Assignment{
				CourseKey:    crs.key,
				TypeCode:     typ.code,
				SessionIndex: typ.sessIdx[ix],
			})

			nci, nti, done := next(ci, ti)
			if done {
				dfs(nci, nti)
			} else {
				dfs(nci, nti)
			}

			picks = picks[:len(picks)-1]
			chosenAll = prevAll
			chosenAtt = prevAtt
			chosenUn = prevUn
		}
	}

	dfs(0, 0)

	if len(bestPlans) == 0 {
		return &SolveResponse{OK: false, Message: "no plan found"}, nil
	}
	out := bestPlans
	if len(out) > maxPlans {
		out = out[:maxPlans]
	}
	return &SolveResponse{
		OK:         true,
		ChosenPlan: &out[0],
		AllOptimal: out,
	}, nil
}

func overlapMinutes(a, b [days]uint32) int {
	mins := 0
	for d := 0; d < days; d++ {
		mins += popcnt32(a[d]&b[d]) * slotMin
	}
	return mins
}

func computeGapBetweenAttendedWithFallback(A, U, B, All [days]uint32) int {
	total := 0
	for d := 0; d < days; d++ {
		anchors := A[d]
		if anchors == 0 {
			anchors = All[d]
		}
		if anchors == 0 {
			continue
		}

		runs := runsFromMask(anchors)
		if len(runs) < 2 {
			continue
		}

		fill := U[d] | B[d]

		for i := 0; i+1 < len(runs); i++ {
			hiPrev := runs[i][1]
			loNext := runs[i+1][0]
			if hiPrev+1 <= loNext-1 {
				between := spanBits(hiPrev+1, loNext-1)
				uncovered := between &^ fill
				total += popcnt32(uncovered) * slotMin
			}
		}
	}
	return total
}

func runsFromMask(m uint32) [][2]int {
	out := make([][2]int, 0, 4)
	if m == 0 {
		return out
	}
	i := 0
	for i < 32 {
		for i < 32 && ((m>>uint(i))&1) == 0 {
			i++
		}
		if i >= 32 {
			break
		}
		start := i
		for i < 32 && ((m>>uint(i))&1) == 1 {
			i++
		}
		end := i - 1
		out = append(out, [2]int{start, end})
	}
	return out
}

func bitsFromB64(b64 string) ([days]uint32, error) {
	var out [days]uint32
	if b64 == "" {
		return out, nil
	}
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return out, err
	}
	if len(raw) != 24 {
		return out, errors.New("expected 24 bytes")
	}
	for bit := 0; bit < totalSlots; bit++ {
		byteIdx := bit >> 3
		bitOff := uint(bit & 7)
		if (raw[byteIdx]>>bitOff)&1 == 1 {
			d := bit / slotsPerDay
			o := uint(bit % slotsPerDay)
			out[d] |= 1 << o
		}
	}
	return out, nil
}

func overlaps(a, b [days]uint32) bool {
	for i := 0; i < days; i++ {
		if (a[i] & b[i]) != 0 {
			return true
		}
	}
	return false
}

func orInto(dst *[days]uint32, src [days]uint32) {
	for i := 0; i < days; i++ {
		dst[i] |= src[i]
	}
}

func popcntMask(m [days]uint32) int {
	sum := 0
	for i := 0; i < days; i++ {
		sum += popcnt32(m[i])
	}
	return sum
}

func popcnt32(x uint32) int {
	c := 0
	for x != 0 {
		x &= x - 1
		c++
	}
	return c
}

func spanBits(lo, hi int) uint32 {
	if lo < 0 {
		lo = 0
	}
	if hi > 31 {
		hi = 31
	}
	if lo > hi {
		return 0
	}
	var m uint32
	for i := lo; i <= hi; i++ {
		m |= 1 << uint(i)
	}
	return m
}

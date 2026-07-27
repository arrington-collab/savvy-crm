import { describe, it, expect } from "vitest";
import { Sparkline, buildSparklineSegments } from "./Sparkline";

// apps/web's vitest config runs in the "node" environment (no jsdom/
// @testing-library here) — so these tests exercise the pure geometry helper
// directly, and call the Sparkline function component itself (a plain
// function returning a React element tree; no renderer needed to inspect
// its `.type`/`.props`).

describe("buildSparklineSegments", () => {
  it("plots 13 values including nulls into one polyline point-string per contiguous non-null run", () => {
    const values: (number | null)[] = [1, 2, null, 3, 4, 5, null, null, 6, 7, 8, 9, 10];
    const segments = buildSparklineSegments(values);

    // null at index 2 splits [1,2] from [3,4,5]; nulls at 6-7 split [3,4,5] from [6,7,8,9,10].
    expect(segments).toHaveLength(3);
    for (const seg of segments) {
      const points = seg.split(" ");
      expect(points.length).toBeGreaterThan(0);
      for (const p of points) {
        const [x, y] = p.split(",").map(Number);
        expect(Number.isFinite(x)).toBe(true);
        expect(Number.isFinite(y)).toBe(true);
      }
    }
  });

  it("returns a single segment when there are no gaps", () => {
    const values = Array.from({ length: 13 }, (_, i) => i);
    const segments = buildSparklineSegments(values);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.split(" ")).toHaveLength(13);
  });

  it("returns [] for an empty array", () => {
    expect(buildSparklineSegments([])).toEqual([]);
  });

  it("returns [] when every entry is null (all-pending week)", () => {
    expect(buildSparklineSegments(Array(13).fill(null))).toEqual([]);
  });

  it("does not divide by zero when every value is identical", () => {
    const segments = buildSparklineSegments([5, 5, 5, 5]);
    expect(segments).toHaveLength(1);
    for (const p of segments[0]!.split(" ")) {
      const [, y] = p.split(",").map(Number);
      expect(Number.isFinite(y)).toBe(true);
    }
  });
});

describe("Sparkline component", () => {
  it("renders an <svg> with one <polyline> per segment for 13 values incl. nulls", () => {
    const values: (number | null)[] = [1, 2, null, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const el = Sparkline({ values });

    expect(el.type).toBe("svg");
    const children = el.props.children as ReturnType<typeof Sparkline>[];
    expect(Array.isArray(children)).toBe(true);
    expect(children).toHaveLength(2); // split once by the null at index 2
    for (const child of children) {
      expect(child.type).toBe("polyline");
      expect(typeof child.props.points).toBe("string");
    }
  });

  it('renders a muted "—" for an empty array', () => {
    const el = Sparkline({ values: [] });
    expect(el.type).toBe("span");
    expect(el.props.children).toBe("—");
  });

  it('renders a muted "—" when every value is pending (null)', () => {
    const el = Sparkline({ values: Array(13).fill(null) });
    expect(el.type).toBe("span");
    expect(el.props.children).toBe("—");
  });
});

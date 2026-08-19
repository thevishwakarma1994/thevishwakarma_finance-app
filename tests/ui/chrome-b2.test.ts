import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve("src/ui/styles.css"), "utf8");
const chrome = readFileSync(resolve("src/ui/chrome.tsx"), "utf8");

function block(selector: string): string {
  const match = css.match(new RegExp(`${selector.replace(/[.]/g, "\\.")}\\s*\\{([^}]+)\\}`));
  return match?.[1] ?? "";
}

describe("UX Stage B.2 chrome", () => {
  it("FAB stays bottom-right above the nav at phone widths", () => {
    const fab = block(".fab");
    expect(fab).toMatch(/position:\s*fixed/);
    expect(fab).toMatch(/right:\s*max\(1rem, env\(safe-area-inset-right\)\)/);
    expect(fab).toMatch(/bottom:\s*calc\(4\.35rem \+ env\(safe-area-inset-bottom\)\)/);
    expect(fab).not.toMatch(/left:\s*50%/);
    expect(fab).not.toMatch(/translateX\(-50%\)/);
    expect(fab).toMatch(/width:\s*56px/);
    expect(fab).toMatch(/height:\s*56px/);
    expect(fab).toMatch(/display:\s*grid/);
    expect(fab).toMatch(/place-items:\s*center/);
    expect(fab).not.toMatch(/line-height/);
    expect(fab).not.toMatch(/font-size/);
  });

  it("plus icon is an SVG whose strokes meet at the geometric center", () => {
    expect(chrome).toMatch(/function PlusIcon/);
    expect(chrome).toMatch(/viewBox="0 0 24 24"/);
    expect(chrome).toMatch(/width="24"/);
    expect(chrome).toMatch(/height="24"/);
    expect(chrome).toMatch(/M12 5v14M5 12h14/);
    expect(block(".fab svg")).toMatch(/display:\s*block/);
  });

  it("header keeps equal side columns so Money stays visually centered with a 44px gear", () => {
    expect(block(".header")).toMatch(/grid-template-columns:\s*3rem 1fr 3rem/);
    expect(block(".header h1")).toMatch(/text-align:\s*center/);
    expect(css).toMatch(/--touch:\s*44px/);
    const icon = block(".header-icon-btn");
    expect(icon).toMatch(/min-width:\s*var\(--touch\)/);
    expect(icon).toMatch(/min-height:\s*var\(--touch\)/);
    expect(icon).toMatch(/width:\s*var\(--touch\)/);
    expect(icon).toMatch(/height:\s*var\(--touch\)/);
  });
});

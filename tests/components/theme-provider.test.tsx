// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, beforeEach } from "vitest";

import { ThemeProvider, useTheme } from "@/components/theme-provider";

function Probe() {
  const { theme, setTheme, toggleTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <button
        type="button"
        data-testid="toggle"
        onClick={() => toggleTheme()}
      >
        toggle
      </button>
      <button
        type="button"
        data-testid="set-light"
        onClick={() => setTheme("light")}
      >
        set-light
      </button>
    </div>
  );
}

describe("ThemeProvider", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("data-theme");
    window.localStorage.clear();
  });

  it("seeds theme from <html data-theme> attribute", () => {
    document.documentElement.setAttribute("data-theme", "light");
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("theme").textContent).toBe("light");
  });

  it("defaults to dark when no data-theme is set", () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("theme").textContent).toBe("dark");
  });

  it("setTheme updates <html data-theme> and localStorage", () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );

    act(() => {
      screen.getByTestId("set-light").click();
    });

    expect(screen.getByTestId("theme").textContent).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(window.localStorage.getItem("scienceswarm.theme")).toBe("light");
  });

  it("toggleTheme flips between light and dark", () => {
    document.documentElement.setAttribute("data-theme", "dark");
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );

    act(() => {
      screen.getByTestId("toggle").click();
    });
    expect(screen.getByTestId("theme").textContent).toBe("light");

    act(() => {
      screen.getByTestId("toggle").click();
    });
    expect(screen.getByTestId("theme").textContent).toBe("dark");
  });

  it("useTheme outside <ThemeProvider> throws a clear error", () => {
    // Silence the expected error noise from React
    const original = console.error;
    console.error = () => {};
    try {
      expect(() => render(<Probe />)).toThrow(
        /useTheme must be used within <ThemeProvider>/,
      );
    } finally {
      console.error = original;
    }
  });
});

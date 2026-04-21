import { describe, expect, it } from "vitest";
import { parseBibtex } from "@/lib/bibtex-parser";

describe("parseBibtex", () => {
  it("parses a single @article entry with common fields", () => {
    const input = `
      @article{knuth1984,
        author = {Knuth, Donald E.},
        title = {Literate Programming},
        journal = {The Computer Journal},
        year = {1984},
        pages = {97--111}
      }
    `;
    const { entries, errors } = parseBibtex(input);
    expect(errors).toEqual([]);
    expect(entries).toHaveLength(1);
    const [e] = entries;
    expect(e.key).toBe("knuth1984");
    expect(e.type).toBe("article");
    expect(e.title).toBe("Literate Programming");
    expect(e.journal).toBe("The Computer Journal");
    expect(e.year).toBe("1984");
    expect(e.pages).toBe("97--111");
    expect(e.authors).toEqual(["Knuth, Donald E."]);
  });

  it("parses a single @inproceedings entry with booktitle", () => {
    const input = `
      @inproceedings{smith2020,
        author = {Smith, Jane},
        title = {On Caching},
        booktitle = {Proceedings of Foo},
        year = {2020}
      }
    `;
    const { entries, errors } = parseBibtex(input);
    expect(errors).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("inproceedings");
    expect(entries[0].booktitle).toBe("Proceedings of Foo");
    expect(entries[0].title).toBe("On Caching");
  });

  it("parses multiple entries in one input", () => {
    const input = `
      @article{a1, author = {A, B}, title = {T1}, year = {2001}}
      @book{b1, author = {C, D}, title = {T2}, publisher = {Pub}, year = {2002}}
      @misc{m1, author = {E, F}, title = {T3}, year = {2003}}
    `;
    const { entries, errors } = parseBibtex(input);
    expect(errors).toEqual([]);
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.key)).toEqual(["a1", "b1", "m1"]);
    expect(entries.map((e) => e.type)).toEqual(["article", "book", "misc"]);
    expect(entries[1].publisher).toBe("Pub");
  });

  it("splits multi-author entries into an authors[] array", () => {
    const input = `
      @article{multi,
        author = {Knuth, Donald E. and Plass, Michael F. and Smith, J.},
        title = {Breaking Paragraphs into Lines},
        year = {1981}
      }
    `;
    const { entries, errors } = parseBibtex(input);
    expect(errors).toEqual([]);
    expect(entries[0].authors).toEqual([
      "Knuth, Donald E.",
      "Plass, Michael F.",
      "Smith, J.",
    ]);
    expect(entries[0].author).toBe(
      "Knuth, Donald E. and Plass, Michael F. and Smith, J.",
    );
  });

  it("handles quoted field values with title = \"...\"", () => {
    const input = `
      @article{q1,
        author = "Doe, Jane",
        title = "A Quoted Title",
        year = "1999"
      }
    `;
    const { entries, errors } = parseBibtex(input);
    expect(errors).toEqual([]);
    expect(entries[0].title).toBe("A Quoted Title");
    expect(entries[0].year).toBe("1999");
    expect(entries[0].author).toBe("Doe, Jane");
  });

  it("keeps escaped quotes inside a quoted field value", () => {
    const input = `
      @article{escaped,
        title = "He said \\\"hello\\\"",
        year = "2024"
      }
    `;
    const { entries, errors } = parseBibtex(input);
    expect(errors).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe('He said \\"hello\\"');
  });

  it("preserves nested braces inside a braced value", () => {
    const input = `
      @book{tex,
        author = {Knuth, Donald E.},
        title = {The {TeX}book},
        publisher = {Addison-Wesley},
        year = {1984}
      }
    `;
    const { entries, errors } = parseBibtex(input);
    expect(errors).toEqual([]);
    // Outer wrapping braces are stripped; nested {TeX} is preserved.
    expect(entries[0].title).toBe("The {TeX}book");
  });

  it("parses a DOI field exactly", () => {
    const input = `
      @article{doi1,
        author = {Lee, A.},
        title = {Something},
        doi = {10.1145/12345},
        year = {2021}
      }
    `;
    const { entries, errors } = parseBibtex(input);
    expect(errors).toEqual([]);
    expect(entries[0].doi).toBe("10.1145/12345");
    expect(entries[0].fields.doi).toBe("10.1145/12345");
  });

  it("returns an empty result for empty input", () => {
    expect(parseBibtex("")).toEqual({ entries: [], errors: [] });
  });

  it("returns an empty result for whitespace-only input", () => {
    expect(parseBibtex("   \n\t\n   ")).toEqual({ entries: [], errors: [] });
  });

  it("records an error for a malformed entry with a missing closing brace but does not throw", () => {
    const input = `
      @article{broken,
        author = {Nobody},
        title = {Unterminated
    `;
    expect(() => parseBibtex(input)).not.toThrow();
    const { entries, errors } = parseBibtex(input);
    expect(entries).toHaveLength(0);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("recovers from a malformed entry and still parses the next good one", () => {
    const input = `
      @article{broken, author = {Nobody}, title = {Unterminated
      @article{good, author = {Good, A.}, title = {Fine}, year = {2024}}
    `;
    expect(() => parseBibtex(input)).not.toThrow();
    const { entries, errors } = parseBibtex(input);
    // The broken entry must surface an error, and the parser must still
    // recover to parse the subsequent good entry.
    expect(errors.length).toBeGreaterThan(0);
    expect(entries).toHaveLength(1);
    expect(entries[0].key).toBe("good");
    expect(entries[0].title).toBe("Fine");
    expect(entries[0].year).toBe("2024");
  });

  it("ignores comment lines starting with %", () => {
    const input = `
      % this is a comment about the next entry
      @article{commented,
        % inline-ish comment line
        author = {C, D},
        title = {Commented},
        year = {2022}
      }
      % trailing comment
    `;
    const { entries, errors } = parseBibtex(input);
    expect(errors).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0].key).toBe("commented");
    expect(entries[0].title).toBe("Commented");
  });

  it("exposes the full verbatim field map on `fields`", () => {
    const input = `
      @phdthesis{thesis1,
        author = {Graduate, Student},
        title = {A Big Thesis},
        school = {Some University},
        year = {2019}
      }
    `;
    const { entries, errors } = parseBibtex(input);
    expect(errors).toEqual([]);
    expect(entries[0].type).toBe("phdthesis");
    expect(entries[0].fields.school).toBe("Some University");
    expect(entries[0].fields.title).toBe("A Big Thesis");
  });

  it("accepts entries delimited with parentheses instead of braces", () => {
    const input = `
      @article(paren1,
        author = {Doe, Jane},
        title = {A Paren-Delimited Entry},
        journal = {J},
        year = {2024}
      )
    `;
    const { entries, errors } = parseBibtex(input);
    expect(errors).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0].key).toBe("paren1");
    expect(entries[0].type).toBe("article");
    expect(entries[0].title).toBe("A Paren-Delimited Entry");
    expect(entries[0].year).toBe("2024");
  });

  it("accepts @techreport, @unpublished, and @inbook types", () => {
    const input = `
      @techreport{tr1, author = {X, Y}, title = {TR}, year = {2010}}
      @unpublished{un1, author = {X, Y}, title = {UN}, year = {2011}}
      @inbook{ib1, author = {X, Y}, title = {IB}, year = {2012}}
    `;
    const { entries, errors } = parseBibtex(input);
    expect(errors).toEqual([]);
    expect(entries.map((e) => e.type)).toEqual([
      "techreport",
      "unpublished",
      "inbook",
    ]);
  });
});

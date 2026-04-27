import { describe, expect, it } from "vitest";
import { parseBbl } from "@/lib/bbl-parser";

describe("parseBbl", () => {
  it("parses a single \\bibitem with the natbib/plain skeleton", () => {
    const input = `\\begin{thebibliography}{10}
\\bibitem[Vaswani et~al.(2017)]{vaswani2017attention}
Ashish Vaswani, Noam Shazeer, and Niki Parmar.
\\newblock Attention is all you need.
\\newblock In \\emph{Advances in Neural Information Processing Systems}, 2017.
\\end{thebibliography}`;
    const { entries, errors } = parseBbl(input);
    expect(errors).toEqual([]);
    expect(entries).toHaveLength(1);
    const [e] = entries;
    expect(e.key).toBe("vaswani2017attention");
    expect(e.title).toBe("Attention is all you need");
    expect(e.authors).toEqual([
      "Ashish Vaswani",
      "Noam Shazeer",
      "Niki Parmar",
    ]);
    expect(e.year).toBe(2017);
    expect(e.venue).toBe("Advances in Neural Information Processing Systems");
  });

  it("parses multiple entries and records the citation keys", () => {
    const input = `\\begin{thebibliography}{10}
\\bibitem[He et~al.(2016)]{he2016resnet}
Kaiming He, Xiangyu Zhang, Shaoqing Ren, and Jian Sun.
\\newblock Deep residual learning for image recognition.
\\newblock In \\emph{CVPR}, pages 770--778, 2016.

\\bibitem[Kingma and Ba(2014)]{kingma2014adam}
Diederik~P. Kingma and Jimmy Ba.
\\newblock Adam: A method for stochastic optimization.
\\newblock \\emph{arXiv preprint arXiv:1412.6980}, 2014.
\\end{thebibliography}`;
    const { entries, errors } = parseBbl(input);
    expect(errors).toEqual([]);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.key)).toEqual([
      "he2016resnet",
      "kingma2014adam",
    ]);
    expect(entries[0].title).toBe("Deep residual learning for image recognition");
    expect(entries[1].title).toBe("Adam: A method for stochastic optimization");
  });

  it("extracts arXiv identifiers from \\url and bare strings", () => {
    const input = `\\begin{thebibliography}{1}
\\bibitem{wei2022cot}
Jason Wei et~al.
\\newblock Chain-of-thought prompting elicits reasoning in large language models.
\\newblock \\url{https://arxiv.org/abs/2201.11903}, 2022.
\\end{thebibliography}`;
    const { entries } = parseBbl(input);
    expect(entries[0].arxiv).toBe("2201.11903");
  });

  it("extracts DOIs in both `doi:` and URL forms", () => {
    const input = `\\begin{thebibliography}{2}
\\bibitem{a}
A. Author.
\\newblock A title.
\\newblock \\emph{Journal}, 2020. doi: 10.1234/abcd.5678.

\\bibitem{b}
B. Author.
\\newblock Another title.
\\newblock \\emph{Other Journal}, 2021. https://doi.org/10.5555/zzz.
\\end{thebibliography}`;
    const { entries } = parseBbl(input);
    expect(entries).toHaveLength(2);
    expect(entries[0].doi).toBe("10.1234/abcd.5678");
    expect(entries[1].doi).toBe("10.5555/zzz");
  });

  it("strips trailing LaTeX braces and parentheses from DOIs wrapped in `\\url{...}` / `\\href{...}{...}`", () => {
    const input = `\\begin{thebibliography}{2}
\\bibitem{u}
U. Author.
\\newblock A url-wrapped DOI title.
\\newblock \\newblock \\url{https://doi.org/10.1145/3386569.3392412}.

\\bibitem{h}
H. Author.
\\newblock A href-wrapped DOI title.
\\newblock \\href{https://doi.org/10.1234/abcd}{Publisher link}.
\\end{thebibliography}`;
    const { entries } = parseBbl(input);
    expect(entries).toHaveLength(2);
    expect(entries[0].doi).toBe("10.1145/3386569.3392412");
    expect(entries[1].doi).toBe("10.1234/abcd");
  });

  it("falls back to \\emph for the title when there are too few \\newblocks", () => {
    const input = `\\begin{thebibliography}{1}
\\bibitem{minimal}
Minimal Author. \\emph{The Minimal Paper}, 2023.
\\end{thebibliography}`;
    const { entries } = parseBbl(input);
    expect(entries[0].title).toBe("The Minimal Paper");
  });

  it("preserves a verbatim rawEntry for downstream fallback", () => {
    const input = `\\begin{thebibliography}{1}
\\bibitem{x}
X. Author.
\\newblock A reference.
\\newblock \\emph{Venue}, 2024.
\\end{thebibliography}`;
    const { entries } = parseBbl(input);
    expect(entries[0].rawEntry).toContain("X. Author");
    expect(entries[0].rawEntry).toContain("\\emph{Venue}");
  });

  it("returns an empty result and no errors for input with no \\bibitem", () => {
    const { entries, errors } = parseBbl("nothing here");
    expect(entries).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("strips trailing inline year/period from the title segment", () => {
    const input = `\\begin{thebibliography}{1}
\\bibitem{strobl-2023}
Lena Strobl.
\\newblock Average-hard attention transformers are constant-depth uniform threshold circuits, 2023.
\\end{thebibliography}`;
    const { entries } = parseBbl(input);
    expect(entries[0].title).toBe(
      "Average-hard attention transformers are constant-depth uniform threshold circuits",
    );
    expect(entries[0].year).toBe(2023);
  });

  it("handles multiple authors separated by commas and `and`", () => {
    const input = `\\begin{thebibliography}{1}
\\bibitem{multi}
Ian Goodfellow, Yoshua Bengio, and Aaron Courville.
\\newblock \\emph{Deep Learning}.
\\newblock MIT Press, 2016.
\\end{thebibliography}`;
    const { entries } = parseBbl(input);
    expect(entries[0].authors).toEqual([
      "Ian Goodfellow",
      "Yoshua Bengio",
      "Aaron Courville",
    ]);
    expect(entries[0].title).toBe("Deep Learning");
    expect(entries[0].year).toBe(2016);
  });

  it("works without an \\end{thebibliography} marker", () => {
    const input = `\\bibitem{a}
Author A.
\\newblock A paper.
\\newblock \\emph{Venue}, 2020.

\\bibitem{b}
Author B.
\\newblock Another paper.
\\newblock \\emph{Other Venue}, 2021.
`;
    const { entries } = parseBbl(input);
    expect(entries).toHaveLength(2);
    expect(entries[0].key).toBe("a");
    expect(entries[1].key).toBe("b");
  });
});

export interface ProtectedMath {
  token: string;
  markdown: string;
}

function formula(source: string, display: boolean) {
  return display ? `\n\n$$\n${source}\n$$\n\n` : `$${source}$`;
}

function hasUnescapedDollar(source: string) {
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "$") continue;
    let slashes = 0;
    for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) slashes += 1;
    if (slashes % 2 === 0) return true;
  }
  return false;
}

export function protectRenderedMath(document: Document): ProtectedMath[] {
  const protectedMath: ProtectedMath[] = [];
  const serialized = document.documentElement?.outerHTML ?? "";
  const replace = (rendered: Element, source: string, display: boolean) => {
    let token = `ZHIYERENDEREDMATHTOKEN${protectedMath.length}X`;
    while (serialized.includes(token)) token += "X";
    protectedMath.push({ token, markdown: formula(source, display) });
    rendered.replaceWith(document.createTextNode(display ? `\n\n${token}\n\n` : token));
  };

  for (const annotation of [...document.querySelectorAll("annotation[encoding]")]) {
    if (!document.documentElement?.contains(annotation)) continue;
    if (annotation.getAttribute("encoding")?.toLowerCase() !== "application/x-tex") continue;
    const source = annotation.textContent ?? "";
    const math = annotation.closest("math");
    if (!source.trim() || hasUnescapedDollar(source) || !math) continue;
    const display = math.getAttribute("display") === "block" || Boolean(annotation.closest(".katex-display, .MathJax_Display"));
    const rendered = display
      ? annotation.closest(".katex-display, .MathJax_Display") ?? math
      : annotation.closest(".katex, .MathJax") ?? math;
    replace(rendered, source, display);
  }

  for (const math of [...document.querySelectorAll(".katex[data-latex], math[data-latex], math[alttext]")]) {
    const source = math.getAttribute("data-latex") || math.getAttribute("alttext") || "";
    if (!source.trim() || hasUnescapedDollar(source)) continue;
    const display = math.getAttribute("display") === "block" || Boolean(math.closest(".katex-display, .MathJax_Display"));
    const rendered = display ? math.closest(".katex-display, .MathJax_Display") ?? math : math.closest(".katex, .MathJax") ?? math;
    replace(rendered, source, display);
  }
  return protectedMath;
}

export function restoreProtectedMath(markdown: string, protectedMath: ProtectedMath[]) {
  for (const value of protectedMath) markdown = markdown.replaceAll(value.token, () => value.markdown);
  return markdown;
}

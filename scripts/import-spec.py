"""Convert the supplied DOCX specification to Markdown, preserving headings and tables."""
from pathlib import Path
from zipfile import ZipFile
from xml.etree import ElementTree as ET
import sys

NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
W = "{" + NS["w"] + "}"

def paragraph_text(node):
    parts = []
    for child in node.iter():
        if child.tag == W + "t":
            parts.append(child.text or "")
        elif child.tag == W + "br":
            parts.append("\n")
        elif child.tag == W + "tab":
            parts.append("    ")
    return "".join(parts)

def convert(source, target):
    with ZipFile(source) as archive:
        body = ET.fromstring(archive.read("word/document.xml")).find("w:body", NS)
    blocks = []
    for node in body:
        if node.tag == W + "p":
            text = paragraph_text(node)
            if not text.strip():
                continue
            style_node = node.find("w:pPr/w:pStyle", NS)
            style = style_node.get(W + "val", "") if style_node is not None else ""
            if style == "Title":
                text = "# " + text
            elif style.startswith("Heading") and style[-1:].isdigit():
                text = "#" * (int(style[-1]) + 1) + " " + text
            elif style == "ListBullet":
                text = "- " + text
            elif "\n" in text:
                text = "```text\n" + text + "\n```"
            blocks.append(text)
        elif node.tag == W + "tbl":
            rows = []
            for row in node.findall("w:tr", NS):
                cells = ["<br>".join(paragraph_text(p) for p in cell.findall("w:p", NS)).replace("|", "\\|").replace("\n", "<br>") for cell in row.findall("w:tc", NS)]
                rows.append("| " + " | ".join(cells) + " |")
                if len(rows) == 1:
                    rows.append("| " + " | ".join("---" for _ in cells) + " |")
            blocks.append("\n".join(rows))
    Path(target).write_text("\n\n".join(blocks) + "\n", encoding="utf-8")

if __name__ == "__main__":
    convert(sys.argv[1], sys.argv[2])

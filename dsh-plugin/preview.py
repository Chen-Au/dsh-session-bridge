import sys
import html
import os

def esc(value):
    return html.escape(str(value or ""), quote=True)

def wrap(title, body):
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>
      :root {{ color-scheme: light; }}
      body {{ margin:0; padding:18px 22px; font:14px/1.6 "Segoe UI","Microsoft YaHei",sans-serif; color:#24262c; background:#fff; }}
      h1 {{ font-size:18px; margin:0 0 14px; }}
      h2 {{ font-size:15px; margin:18px 0 8px; border-bottom:1px solid #e6e8ee; padding-bottom:5px; }}
      h3 {{ font-size:13.5px; margin:14px 0 6px; }}
      p {{ margin:6px 0; white-space:pre-wrap; }}
      table {{ border-collapse:collapse; margin:8px 0 14px; font-size:12px; }}
      td, th {{ border:1px solid #d9dde6; padding:4px 7px; vertical-align:top; }}
      th {{ background:#f4f6fa; font-weight:600; }}
      .meta {{ color:#7b8190; font-size:11.5px; margin-bottom:12px; }}
      .slide {{ border:1px solid #e6e8ee; border-radius:8px; padding:12px 14px; margin:0 0 12px; }}
      .shape {{ margin:4px 0; white-space:pre-wrap; }}
      .empty {{ color:#9aa0ad; padding:16px; }}
    </style></head><body><h1>{esc(title)}</h1>{body}</body></html>"""

def docx_preview(path):
    from docx import Document
    doc = Document(path)
    parts = []
    for para in doc.paragraphs:
        text = para.text.strip()
        if not text:
            continue
        style = (para.style.name or "").lower() if para.style else ""
        if "heading 1" in style or "标题 1" in style:
            parts.append(f"<h2>{esc(text)}</h2>")
        elif "heading 2" in style or "标题 2" in style:
            parts.append(f"<h3>{esc(text)}</h3>")
        else:
            parts.append(f"<p>{esc(text)}</p>")
    for index, table in enumerate(doc.tables[:12]):
        rows = []
        for row in table.rows[:80]:
            cells = "".join(f"<td>{esc(cell.text.strip())}</td>" for cell in row.cells)
            rows.append(f"<tr>{cells}</tr>")
        parts.append(f"<h3>表格 {index + 1}</h3><table>{''.join(rows)}</table>")
    return "".join(parts) or "<div class='empty'>文档没有可显示的文本。</div>"

def xlsx_preview(path):
    from openpyxl import load_workbook
    book = load_workbook(path, read_only=True, data_only=True)
    parts = []
    for sheet_name in book.sheetnames[:5]:
        sheet = book[sheet_name]
        rows = []
        max_cols = 0
        for row_index, row in enumerate(sheet.iter_rows(values_only=True)):
            if row_index >= 120:
                break
            values = ["" if cell is None else str(cell) for cell in row[:30]]
            max_cols = max(max_cols, len(values))
            rows.append("<tr>" + "".join(f"<td>{esc(v)}</td>" for v in values) + "</tr>")
        parts.append(f"<h2>{esc(sheet_name)}</h2><table>{''.join(rows) or '<tr><td class=\"empty\">空表</td></tr>'}</table>")
    return "".join(parts) or "<div class='empty'>工作簿没有可显示的内容。</div>"

def pptx_preview(path):
    from pptx import Presentation
    deck = Presentation(path)
    parts = []
    for index, slide in enumerate(deck.slides):
        texts = []
        for shape in slide.shapes:
            if not getattr(shape, "has_text_frame", False):
                continue
            for paragraph in shape.text_frame.paragraphs:
                text = "".join(run.text for run in paragraph.runs).strip()
                if text:
                    texts.append(f"<div class='shape'>{esc(text)}</div>")
        parts.append(f"<div class='slide'><h3>第 {index + 1} 页</h3>{''.join(texts) or '<div class=\"empty\">（无文字）</div>'}</div>")
    return "".join(parts) or "<div class='empty'>演示文稿没有可显示的文字。</div>"

def main():
    if len(sys.argv) < 2:
        print(wrap("无法预览", "<div class='empty'>缺少文件路径。</div>"))
        return
    path = sys.argv[1]
    ext = os.path.splitext(path)[1].lower()
    name = os.path.basename(path)
    try:
        if ext == ".docx":
            body = docx_preview(path)
        elif ext == ".xlsx":
            body = xlsx_preview(path)
        elif ext == ".pptx":
            body = pptx_preview(path)
        else:
            body = "<div class='empty'>不支持的文件类型。</div>"
        print(wrap(name, body))
    except Exception as error:
        print(wrap(name, f"<div class='empty'>预览失败：{esc(error)}</div>"))

if __name__ == "__main__":
    main()

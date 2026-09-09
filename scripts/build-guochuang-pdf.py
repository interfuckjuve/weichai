"""Build the technical replacement and merge it with the user's original PDF.

Usage: python scripts/build-guochuang-pdf.py --original PATH
Dependencies: reportlab, pypdf, pdfplumber, matplotlib. Chinese fonts default to Windows fonts.
"""
from pathlib import Path
import argparse
import copy
import io
import json
import re
from html import escape

import pdfplumber
from pypdf import PdfReader, PdfWriter
from pypdf.generic import DictionaryObject, NameObject, NumberObject, ArrayObject
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_CENTER
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table, TableStyle, Flowable, Image as PDFImage
from matplotlib.mathtext import math_to_image

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'output/pdf'
TMP = ROOT / 'tmp/pdfs'
WIDTH, HEIGHT = 595.28, 841.89
CONTENT = WIDTH - 144
BLUE = colors.HexColor('#2255A4')
GRAY = colors.HexColor('#53616D')


def register_fonts(font_dir):
    pdfmetrics.registerFont(TTFont('Song', str(font_dir / 'simsun.ttc'), subfontIndex=0))
    pdfmetrics.registerFont(TTFont('Hei', str(font_dir / 'msyhbd.ttc'), subfontIndex=0))


styles = {
    'p': ParagraphStyle('p', fontName='Song', fontSize=10.5, leading=17.5, firstLineIndent=21, spaceAfter=7, wordWrap='CJK', allowWidows=0, allowOrphans=0),
    'h1': ParagraphStyle('h1', fontName='Hei', fontSize=20, leading=30, spaceBefore=17, spaceAfter=25, keepWithNext=True, wordWrap='CJK'),
    'h2': ParagraphStyle('h2', fontName='Hei', fontSize=13, leading=21, spaceBefore=12, spaceAfter=8, keepWithNext=True, wordWrap='CJK'),
    'cell': ParagraphStyle('cell', fontName='Song', fontSize=9.3, leading=15, wordWrap='CJK'),
    'toc': ParagraphStyle('toc', fontName='Song', fontSize=10, leading=16, spaceAfter=3, wordWrap='CJK'),
    'tocchapter': ParagraphStyle('tocchapter', fontName='Hei', fontSize=11, leading=18, spaceBefore=8, spaceAfter=3, keepWithNext=True, wordWrap='CJK'),
}


class Pipeline(Flowable):
    def __init__(self):
        Flowable.__init__(self)
        self.width = CONTENT
        self.height = 62

    def draw(self):
        c = self.canv
        names = ['源码快照', '索引与建模', '任务检索', '上下文交付', '开发验证']
        for i, name in enumerate(names):
            x = i * 92
            c.setFillColor(colors.HexColor('#EDF3FA'))
            c.setStrokeColor(BLUE)
            c.roundRect(x, 17, 82, 32, 4, fill=1, stroke=1)
            c.setFillColor(BLUE)
            c.setFont('Song', 10)
            c.drawCentredString(x + 41, 29, name)
            if i < 4:
                c.line(x + 83, 33, x + 90, 33)
                c.line(x + 90, 33, x + 87, 35)
                c.line(x + 90, 33, x + 87, 31)


class Doc(SimpleDocTemplate):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.headings = []

    def afterFlowable(self, item):
        if hasattr(item, 'heading'):
            level, title = item.heading
            self.headings.append((level, title, self.page + 12))


def footer(c, doc):
    c.setFont('Song', 9)
    c.setFillColor(GRAY)
    c.drawString(72, HEIGHT - 43, 'RECAST  项目说明书')
    c.drawRightString(WIDTH - 72, HEIGHT - 43, '技术部分修订版 · 2026.09')
    c.setStrokeColor(colors.HexColor('#CCD7E2'))
    c.line(72, HEIGHT - 51, WIDTH - 72, HEIGHT - 51)
    c.setFillColor(colors.black)
    c.setFont('Song', 10)
    c.drawCentredString(WIDTH / 2, 39, str(doc.page + 12))


def parse_md(text):
    blocks = re.split(r'\n\s*\n', text.strip())
    story = []
    for block in blocks:
        if block.startswith('# '):
            if story:
                story.append(PageBreak())
            p = Paragraph(escape(block[2:]), styles['h1'])
            p.heading = (0, block[2:])
            story.append(p)
        elif block.startswith('## '):
            p = Paragraph(escape(block[3:]), styles['h2'])
            p.heading = (1, block[3:])
            story.append(p)
        elif block.startswith('$$'):
            stream = io.BytesIO()
            math_to_image('$' + block.strip()[2:-2] + '$', stream, dpi=300, format='png')
            from PIL import Image
            stream.seek(0)
            with Image.open(stream) as rendered:
                w, h = rendered.size
            stream.seek(0)
            scale = min(CONTENT / w, 72 / 300 * 1.15)
            formula = PDFImage(stream, width=w * scale, height=h * scale)
            story.extend([Spacer(1, 5), formula, Spacer(1, 12)])
        elif block.startswith('|'):
            rows = [[x.strip() for x in line.strip('|').split('|')] for line in block.splitlines()]
            rows.pop(1)
            table = Table([[Paragraph(escape(x), styles['cell']) for x in row] for row in rows],
                          colWidths=[CONTENT * .22, CONTENT * .37, CONTENT * .41], repeatRows=1, hAlign='LEFT')
            table.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#EDF3FA')),
                ('LINEABOVE', (0, 0), (-1, 0), 1, BLUE),
                ('LINEBELOW', (0, 0), (-1, 0), .6, BLUE),
                ('LINEBELOW', (0, -1), (-1, -1), .8, BLUE),
                ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#F7F9FB')]),
                ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                ('LEFTPADDING', (0, 0), (-1, -1), 7), ('RIGHTPADDING', (0, 0), (-1, -1), 7),
                ('TOPPADDING', (0, 0), (-1, -1), 7), ('BOTTOMPADDING', (0, 0), (-1, -1), 7),
            ]))
            story.extend([table, Spacer(1, 10)])
        else:
            story.append(Paragraph(escape(block.replace('\n', ' ')), styles['p']))
            if block.startswith('基于上述分析，RECAST'):
                story.append(Pipeline())
    return story


def to_latex(text):
    def tex(s):
        return ''.join({'\\': r'\textbackslash{}', '&': r'\&', '%': r'\%', '$': r'\$', '#': r'\#',
                        '_': r'\_', '{': r'\{', '}': r'\}', '~': r'\textasciitilde{}', '^': r'\textasciicircum{}'}.get(c, c) for c in s)
    output = ['% Generated from guochuang-technical-chapters.zh-CN.md; edit the Markdown source.']
    labels = ['architecture', 'indexing', 'methods', 'implementation', 'validation']
    chapter = 0
    for block in re.split(r'\n\s*\n', text.strip()):
        if block.startswith('# '):
            title = re.sub(r'^第.章\s*', '', block[2:])
            output += [r'\chapter{' + tex(title) + '}', r'\label{chap:' + labels[chapter] + '}']
            if chapter == 0:
                output.append(r'\label{chap:challenges}')
            chapter += 1
        elif block.startswith('## '):
            output.append(r'\section{' + tex(re.sub(r'^\d+\.\d+\s+', '', block[3:])) + '}')
        elif block.startswith('$$'):
            output += [r'\begin{equation}', block.strip()[2:-2], r'\end{equation}']
        elif block.startswith('|'):
            rows = [[x.strip() for x in line.strip('|').split('|')] for line in block.splitlines()]
            rows.pop(1)
            output += [r'\begin{center}\small', r'\begin{longtable}{P{0.19\textwidth}P{0.33\textwidth}P{0.38\textwidth}}', r'\toprule']
            for i, row in enumerate(rows):
                output.append(' & '.join(tex(x) for x in row) + r' \\')
                if i == 0:
                    output.append(r'\midrule\endhead')
            output += [r'\bottomrule', r'\end{longtable}\end{center}']
        else:
            output.append(tex(block))
        output.append('')
    (ROOT / 'docs/guochuang-technical-chapters.zh-CN.tex').write_text('\n'.join(output), encoding='utf-8')


def original_toc(original, tech_pages, headings):
    entries = []
    with pdfplumber.open(original) as src:
        for page in src.pages[1:7]:
            for line in page.extract_text().splitlines():
                chapter = re.match(r'^(第[一二三九十]章\s+.+?)\s+(\d+)$', line)
                section = re.match(r'^((?:[1239]|10)\.\d+\s+.+?)\s+(\d+)$', line)
                found = chapter or section
                if found:
                    title = re.sub(r'\s*\.\s*', ' ', found[1]) if not chapter else found[1]
                    if section:
                        number = re.match(r'^(\d+\.\d+)', line)[1]
                        rest = re.sub(r'(?:\s*\.)+\s*$', '', line[len(number):].rsplit(None, 1)[0]).strip()
                        title = number + ' ' + rest
                    page_no = int(found[2])
                    if page_no >= 25:
                        page_no += tech_pages - 12
                    entries.append((0 if chapter else 1, title, page_no))
    return sorted(entries + headings, key=lambda x: x[2])


def toc_pdf(entries):
    story = [Paragraph('目录', styles['h1'])]
    for level, title, page in entries:
        label = ('　' if level else '') + title
        row = Table([[Paragraph(escape(label), styles['toc' if level else 'tocchapter']),
                      Paragraph(str(page), styles['toc'])]], colWidths=[CONTENT - 35, 35])
        row.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'BOTTOM'), ('TOPPADDING', (0, 0), (-1, -1), 1),
                                ('BOTTOMPADDING', (0, 0), (-1, -1), 1)]))
        story.append(row)
    path = TMP / 'contents.pdf'
    SimpleDocTemplate(str(path), pagesize=(WIDTH, HEIGHT), leftMargin=72, rightMargin=72, topMargin=65, bottomMargin=60).build(story)
    return PdfReader(path)


def renumber(page, number, header=False):
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(WIDTH, HEIGHT))
    c.setFillColor(colors.white)
    if header:
        c.rect(491, HEIGHT - 53, 38, 24, fill=1, stroke=0)
        c.setFillColor(colors.black)
        c.setFont('Song', 11)
        c.drawRightString(519, HEIGHT - 47, str(number))
    else:
        c.rect(278, 32, 40, 23, fill=1, stroke=0)
        c.setFillColor(colors.black)
        c.setFont('Song', 11)
        c.drawCentredString(WIDTH / 2, 42, str(number))
    c.save()
    result = copy.deepcopy(page)
    result.merge_page(PdfReader(buf).pages[0])
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--original', type=Path, required=True)
    ap.add_argument('--font-dir', type=Path, default=Path('C:/Windows/Fonts'))
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    TMP.mkdir(parents=True, exist_ok=True)
    register_fonts(args.font_dir)
    text = (ROOT / 'docs/guochuang-technical-chapters.zh-CN.md').read_text(encoding='utf-8')
    to_latex(text)
    tech_path = OUT / 'guochuang-technical-revised.pdf'
    doc = Doc(str(tech_path), pagesize=(WIDTH, HEIGHT), leftMargin=72, rightMargin=72,
              topMargin=68, bottomMargin=65, title='RECAST 项目说明书 第四至第八章修订稿', author='RECAST 项目团队')
    doc.build(parse_md(text), onFirstPage=footer, onLaterPages=footer)
    tech = PdfReader(tech_path)
    n = len(tech.pages)
    entries = original_toc(args.original, n, doc.headings)
    toc = toc_pdf(entries)
    src = PdfReader(args.original)
    assert len(src.pages) == 36, 'Original page mapping expects the supplied 36-page guochuang.pdf.'
    writer = PdfWriter()
    writer.add_page(src.pages[0])
    for page in toc.pages:
        writer.add_page(page)
    front = len(writer.pages)
    for page in src.pages[7:19]:
        writer.add_page(page)
    for page in tech.pages:
        writer.add_page(page)
    for i, page in enumerate(src.pages[31:]):
        writer.add_page(renumber(page, 13 + n + i, header=i in (1, 2, 3)))
    parent = None
    for level, title, page in entries:
        entry = writer.add_outline_item(title, front + page - 1, parent=parent if level else None)
        if not level:
            parent = entry
    writer.add_metadata({'/Title': 'RECAST 项目说明书（技术部分重整版）', '/Author': 'RECAST 项目团队',
                         '/Subject': '第四至第八章依据 chiparon/weichai 9-8-v c3f09d3 重整；其他正文保留原PDF'})
    writer._root_object[NameObject('/PageLabels')] = DictionaryObject({NameObject('/Nums'): ArrayObject([
        NumberObject(0), DictionaryObject({NameObject('/S'): NameObject('/r')}),
        NumberObject(front), DictionaryObject({NameObject('/S'): NameObject('/D'), NameObject('/St'): NumberObject(1)})])})
    full = OUT / 'guochuang-integrated-revised.pdf'
    writer.write(full)
    manifest = {'source_commit': 'c3f09d3', 'technical_pages': n, 'full_pages': len(writer.pages),
                'front_pages': front, 'headings': doc.headings, 'contents': entries,
                'outputs': [str(full), str(tech_path)], 'original_body_pages_preserved': '8-19,32-36 (1-based); chapter 9-10 page numbers updated'}
    (TMP / 'build-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()

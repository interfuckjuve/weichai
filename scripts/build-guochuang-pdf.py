"""Build the revised full proposal and technical excerpt from Markdown.

Usage: python scripts/build-guochuang-pdf.py --original PATH
Dependencies: reportlab, pypdf, pdfplumber, matplotlib. Chinese fonts default to Windows fonts.
"""
from pathlib import Path
import argparse
import io
import json
import re
from html import escape

from pypdf import PdfReader, PdfWriter
from pypdf.generic import DictionaryObject, NameObject, NumberObject, ArrayObject
from reportlab.lib import colors
from reportlab.lib import textsplit
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
# ReportLab's default CJK list omits several full-width Chinese punctuation marks.
textsplit.ALL_CANNOT_START += '，。：；！？）》…'


def register_fonts(font_dir):
    pdfmetrics.registerFont(TTFont('Song', str(font_dir / 'simsun.ttc'), subfontIndex=0))
    pdfmetrics.registerFont(TTFont('Hei', str(font_dir / 'msyhbd.ttc'), subfontIndex=0))


styles = {
    'p': ParagraphStyle('p', fontName='Song', fontSize=10.5, leading=17.5, firstLineIndent=21, spaceAfter=7, wordWrap='CJK', allowWidows=0, allowOrphans=0),
    'h1': ParagraphStyle('h1', fontName='Hei', fontSize=20, leading=30, spaceBefore=17, spaceAfter=25, keepWithNext=True, wordWrap='CJK'),
    'h2': ParagraphStyle('h2', fontName='Hei', fontSize=13, leading=21, spaceBefore=12, spaceAfter=8, keepWithNext=True, wordWrap='CJK'),
    'h3': ParagraphStyle('h3', fontName='Hei', fontSize=11, leading=18, spaceBefore=9, spaceAfter=6, keepWithNext=True, wordWrap='CJK'),
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
        names = ['源码快照', '建立索引', '查找实现', '整理上下文', '修改与验证']
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
        self.page_offset = kwargs.pop('page_offset', 0)
        super().__init__(*args, **kwargs)
        self.headings = []

    def afterFlowable(self, item):
        if hasattr(item, 'heading'):
            level, title = item.heading
            self.headings.append((level, title, self.page + self.page_offset))


def footer(c, doc):
    c.setFont('Song', 9)
    c.setFillColor(GRAY)
    c.drawString(72, HEIGHT - 43, 'RECAST  项目说明书')
    c.drawRightString(WIDTH - 72, HEIGHT - 43, '全文修订版 · 2026.09')
    c.setStrokeColor(colors.HexColor('#CCD7E2'))
    c.line(72, HEIGHT - 51, WIDTH - 72, HEIGHT - 51)
    c.setFillColor(colors.black)
    c.setFont('Song', 10)
    c.drawCentredString(WIDTH / 2, 39, str(doc.page + doc.page_offset))


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
        elif block.startswith('### '):
            p = Paragraph(escape(block[4:]), styles['h3'])
            p.heading = (2, block[4:])
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
            proportions = [.22, .37, .41]
            if len(rows[0]) == 2:
                proportions = [.21, .79]
            elif rows[0][0] == '姓名':
                proportions = [.13, .21, .66]
            table = Table([[Paragraph(escape(x), styles['cell']) for x in row] for row in rows],
                          colWidths=[CONTENT * value for value in proportions], repeatRows=1, hAlign='LEFT')
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
            if block.startswith('RECAST 的处理过程分为四步'):
                story.append(Pipeline())
    return story


def to_latex(text, stem, labels):
    def tex(s):
        return ''.join({'\\': r'\textbackslash{}', '&': r'\&', '%': r'\%', '$': r'\$', '#': r'\#',
                        '_': r'\_', '{': r'\{', '}': r'\}', '~': r'\textasciitilde{}', '^': r'\textasciicircum{}'}.get(c, c) for c in s)
    output = ['% Generated from ' + stem + '.md; edit the Markdown source.']
    chapter = 0
    for block in re.split(r'\n\s*\n', text.strip()):
        if block.startswith('# '):
            title = re.sub(r'^第[一二三四五六七八九十]+章\s*', '', block[2:])
            output += [r'\chapter{' + tex(title) + '}', r'\label{chap:' + labels[chapter] + '}']
            if labels[chapter] == 'architecture':
                output.append(r'\label{chap:challenges}')
            chapter += 1
        elif block.startswith('## '):
            output.append(r'\section{' + tex(re.sub(r'^\d+\.\d+\s+', '', block[3:])) + '}')
        elif block.startswith('### '):
            output.append(r'\subsection{' + tex(re.sub(r'^\d+\.\d+\.\d+\s+', '', block[4:])) + '}')
        elif block.startswith('$$'):
            output += [r'\begin{equation}', block.strip()[2:-2], r'\end{equation}']
        elif block.startswith('|'):
            rows = [[x.strip() for x in line.strip('|').split('|')] for line in block.splitlines()]
            rows.pop(1)
            widths = [.19, .33, .38] if len(rows[0]) == 3 else [.19, .71]
            if rows[0][0] == '姓名':
                widths = [.12, .19, .59]
            columns = ''.join('P{' + str(w) + r'\textwidth}' for w in widths)
            output += [r'\begin{center}\small', r'\begin{longtable}{' + columns + '}', r'\toprule']
            for i, row in enumerate(rows):
                output.append(' & '.join(tex(x) for x in row) + r' \\')
                if i == 0:
                    output.append(r'\midrule\endhead')
            output += [r'\bottomrule', r'\end{longtable}\end{center}']
        else:
            output.append(tex(block))
        output.append('')
    (ROOT / 'docs' / (stem + '.tex')).write_text('\n'.join(output), encoding='utf-8')


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


def corrected_cover():
    stream = io.BytesIO()
    c = canvas.Canvas(stream, pagesize=(WIDTH, HEIGHT))
    c.setFont('Hei', 26)
    c.drawCentredString(WIDTH / 2, HEIGHT - 202, 'RECAST - 面向大型工业软件的')
    c.drawCentredString(WIDTH / 2, HEIGHT - 252, '智能检索与自适应开发平台')
    c.setFont('Hei', 24)
    c.drawCentredString(WIDTH / 2, HEIGHT - 333, '项目说明书')
    c.setFont('Song', 16)
    c.drawCentredString(WIDTH / 2, HEIGHT - 395, 'RECAST')
    c.setFont('Song', 14)
    c.drawCentredString(WIDTH / 2, 160, '项目团队')
    c.drawCentredString(WIDTH / 2, 120, '2026 年 9 月')
    c.save()
    return PdfReader(stream).pages[0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--original', type=Path, required=True)
    ap.add_argument('--font-dir', type=Path, default=Path('C:/Windows/Fonts'))
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    TMP.mkdir(parents=True, exist_ok=True)
    register_fonts(args.font_dir)
    segments = [
        ('guochuang-front-chapters.zh-CN', TMP / 'front-chapters.pdf', ['overview', 'requirements', 'market']),
        ('guochuang-technical-chapters.zh-CN', OUT / 'guochuang-technical-revised.pdf',
         ['architecture', 'indexing', 'methods', 'implementation', 'validation']),
        ('guochuang-closing-chapters.zh-CN', TMP / 'closing-chapters.pdf', ['team', 'conclusion']),
    ]
    offset, entries, readers, counts = 0, [], [], []
    for stem, path, labels in segments:
        text = (ROOT / 'docs' / (stem + '.md')).read_text(encoding='utf-8')
        to_latex(text, stem, labels)
        doc = Doc(str(path), pagesize=(WIDTH, HEIGHT), leftMargin=72, rightMargin=72,
                  topMargin=68, bottomMargin=65, page_offset=offset,
                  title='RECAST 项目说明书', author='RECAST 项目团队')
        doc.build(parse_md(text), onFirstPage=footer, onLaterPages=footer)
        reader = PdfReader(path)
        readers.append(reader)
        counts.append(len(reader.pages))
        entries.extend(item for item in doc.headings if item[0] < 2)
        offset += len(reader.pages)
    toc = toc_pdf(entries)
    assert len(PdfReader(args.original).pages) == 36, 'Expected the supplied 36-page source proposal.'
    writer = PdfWriter()
    writer.add_page(corrected_cover())
    for page in toc.pages:
        writer.add_page(page)
    front = len(writer.pages)
    for reader in readers:
        for page in reader.pages:
            writer.add_page(page)
    parent = None
    for level, title, page in entries:
        entry = writer.add_outline_item(title, front + page - 1, parent=parent if level else None)
        if not level:
            parent = entry
    writer.add_metadata({'/Title': 'RECAST 项目说明书（全文措辞修订版）', '/Author': 'RECAST 项目团队',
                         '/Subject': '基于上游 a02e903 与 huawei 实现；全文措辞修订'})
    writer._root_object[NameObject('/PageLabels')] = DictionaryObject({NameObject('/Nums'): ArrayObject([
        NumberObject(0), DictionaryObject({NameObject('/S'): NameObject('/r')}),
        NumberObject(front), DictionaryObject({NameObject('/S'): NameObject('/D'), NameObject('/St'): NumberObject(1)})])})
    full = OUT / 'guochuang-integrated-revised.pdf'
    writer.write(full)
    tech_path = segments[1][1]
    manifest = {'source_commit': 'a02e903', 'technical_pages': counts[1], 'full_pages': len(writer.pages),
                'front_pages': front, 'body_segment_pages': counts, 'technical_start_page': counts[0] + 1,
                'contents': entries, 'outputs': [str(full), str(tech_path)],
                'original_pages_preserved': 'none; all chapters rebuilt from editable Markdown; duplicate cover wording corrected'}
    (TMP / 'build-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()

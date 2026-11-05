"""Regenerate slides: uv run --with python-pptx==1.0.2 tools/generate-powerpoint-fixture.py."""
from pathlib import Path
from pptx import Presentation

root = Path(__file__).parent / 'fixtures' / 'powerpoint'
root.mkdir(parents=True, exist_ok=True)
slides = Presentation()
for title, body in [('季度汇报', 'Slideoneneedle'), ('工作交接', 'Slidetwoneedle')]:
    slide = slides.slides.add_slide(slides.slide_layouts[1])
    slide.shapes.title.text = title
    slide.placeholders[1].text = body
slides.save(root / 'slides.pptx')

"""Regenerate test workbooks: uv run --with xlwt==1.3.0 --with openpyxl==3.1.5 tools/generate-excel-fixtures.py."""
from pathlib import Path
import xlwt
from openpyxl import Workbook

root = Path(__file__).parent / 'fixtures' / 'excel'
root.mkdir(parents=True, exist_ok=True)
sheets = {
    '员工清单': [['姓名', '部门', '金额'], ['测试员工', 'Payrollneedle', 1234.5]],
    '交接记录': [['事项', '状态'], ['Handoverneedle', '已交接']],
}
legacy = xlwt.Workbook()
modern = Workbook()
modern.remove(modern.active)
for name, rows in sheets.items():
    old_sheet = legacy.add_sheet(name)
    new_sheet = modern.create_sheet(name)
    for r, row in enumerate(rows):
        new_sheet.append(row)
        for c, value in enumerate(row):
            old_sheet.write(r, c, value)
legacy.save(str(root / 'workbook.xls'))
modern.save(root / 'workbook.xlsx')

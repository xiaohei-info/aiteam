import pdfplumber

pdf_path = r"C:\Users\Chao\Desktop\AI Team\AI Team — 商业产品文档（BPD）.pdf"

with pdfplumber.open(pdf_path) as pdf:
    print(f"Total pages: {len(pdf.pages)}")
    for i, page in enumerate(pdf.pages):
        text = page.extract_text()
        if text:
            print(f"\n===== Page {i+1} =====")
            print(text)

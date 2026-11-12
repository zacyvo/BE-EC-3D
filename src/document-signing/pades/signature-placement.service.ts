import { Injectable, Logger } from '@nestjs/common';
import { loadPdfjs, STANDARD_FONT_DATA_URL } from '../pdfjs/pdfjs-loader';
import type { SignatureAppearance } from './pades-sign.service';

interface TextSegment {
  text: string;
  x1: number;
  x2: number;
  y: number;
  h: number;
}

const BOX_WIDTH = 200;
const BOX_HEIGHT = 56;
const MIN_BOX_HEIGHT = 34;

const normalize = (s: string) => s.normalize('NFC').toUpperCase().replace(/\s+/g, ' ').trim();

/**
 * Xác định vị trí hiển thị chữ ký số trên văn bản: tìm dòng tiêu đề khối ký "ĐẠI DIỆN BÊN A/B"
 * (có ở cả 2 template hệ thống và đa số hợp đồng soạn ngoài), đặt khung chữ ký vào khoảng trống
 * giữa dòng hướng dẫn "(Ký, ghi rõ họ tên)" và họ tên in sẵn bên dưới. Không tìm thấy → góc dưới
 * bên phải trang cuối.
 */
@Injectable()
export class SignaturePlacementService {
  private readonly logger = new Logger(SignaturePlacementService.name);

  async resolve(pdf: Buffer, party: 'A' | 'B'): Promise<SignatureAppearance & { anchored: boolean }> {
    const pdfjsLib = await loadPdfjs();
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(pdf),
      standardFontDataUrl: STANDARD_FONT_DATA_URL,
      useSystemFonts: true,
    });
    try {
      const doc = await loadingTask.promise;
      const heading = new RegExp(`ĐẠI DIỆN (CHO )?BÊN ${party}(?![\\p{L}])`, 'u');
      let lastView: number[] = [0, 0, 595.28, 841.89];

      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        lastView = page.view;
        const segments = await this.segments(page);
        const anchor = segments.find((s) => heading.test(normalize(s.text)));
        if (anchor) {
          return { pageIndex: i - 1, rect: this.boxBelow(anchor, segments, page.view), anchored: true };
        }
      }

      const [x1, y1, x2] = lastView;
      return {
        pageIndex: doc.numPages - 1,
        rect: [x2 - 40 - BOX_WIDTH, y1 + 40, Math.max(x1, x2 - 40), y1 + 40 + BOX_HEIGHT],
        anchored: false,
      };
    } catch (err) {
      this.logger.warn(`Không xác định được vị trí chữ ký: ${(err as Error).message}`);
      throw err;
    } finally {
      await loadingTask.destroy();
    }
  }

  private boxBelow(anchor: TextSegment, segments: TextSegment[], view: number[]): [number, number, number, number] {
    const cx = (anchor.x1 + anchor.x2) / 2;
    const below = segments
      .filter((s) => s.y < anchor.y - 1 && Math.abs((s.x1 + s.x2) / 2 - cx) < 100)
      .sort((a, b) => b.y - a.y);

    let top = anchor.y - Math.max(2, anchor.h * 0.3);
    let i = 0;
    // Dòng hướng dẫn ngay dưới tiêu đề, VD "(Ký, ghi rõ họ tên)"
    if (below[0] && below[0].text.trim().startsWith('(') && anchor.y - below[0].y < anchor.h * 3) {
      top = below[0].y - Math.max(2, below[0].h * 0.3);
      i = 1;
    }
    const next = below[i];
    let bottom = next ? next.y + next.h + 1 : top - BOX_HEIGHT;
    if (top - bottom > BOX_HEIGHT + 14) bottom = top - BOX_HEIGHT;
    if (top - bottom < MIN_BOX_HEIGHT) bottom = top - MIN_BOX_HEIGHT;

    const [vx1, vy1, vx2] = view;
    // Khối ký sát cuối trang: không để khung tràn ra mép giấy
    bottom = Math.max(bottom, vy1 + 18);
    const x1 = Math.min(Math.max(cx - BOX_WIDTH / 2, vx1 + 10), vx2 - 10 - BOX_WIDTH);
    return [x1, bottom, x1 + BOX_WIDTH, top];
  }

  /** Gom text item của pdfjs thành các đoạn trên cùng 1 dòng, tách cột khi khoảng cách lớn */
  private async segments(page: { getTextContent: () => Promise<{ items: unknown[] }> }): Promise<TextSegment[]> {
    const content = await page.getTextContent();
    const items = (content.items as { str?: string; transform?: number[]; width?: number; height?: number }[])
      .filter((it) => typeof it.str === 'string' && it.str.trim() && Array.isArray(it.transform))
      .map((it) => {
        const t = it.transform as number[];
        const h = it.height || Math.hypot(t[2], t[3]) || 10;
        return { text: it.str as string, x1: t[4], x2: t[4] + (it.width ?? 0), y: t[5], h };
      })
      .sort((a, b) => b.y - a.y || a.x1 - b.x1);

    const rows: TextSegment[][] = [];
    for (const it of items) {
      const row = rows[rows.length - 1];
      if (row && Math.abs(row[0].y - it.y) <= 2) row.push(it);
      else rows.push([it]);
    }

    const segments: TextSegment[] = [];
    for (const row of rows) {
      row.sort((a, b) => a.x1 - b.x1);
      let cur: TextSegment | undefined;
      for (const it of row) {
        const gap = cur ? it.x1 - cur.x2 : Infinity;
        if (cur && gap < Math.max(12, it.h * 1.5)) {
          cur.text += gap > it.h * 0.15 ? ` ${it.text}` : it.text;
          cur.x2 = Math.max(cur.x2, it.x2);
          cur.h = Math.max(cur.h, it.h);
        } else {
          cur = { ...it };
          segments.push(cur);
        }
      }
    }
    return segments;
  }
}

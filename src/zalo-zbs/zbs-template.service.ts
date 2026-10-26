import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  ZbsTemplateVerification,
  ZbsTemplateVerificationDocument,
} from './schemas/zbs-template-verification.schema';
import { ZbsApiClient } from './zbs-api.client';
import { ZbsAuthService } from './zbs-auth.service';
import { compareMappingWithTemplate, ZbsTemplateParamSpec } from './zbs-template.mapper';
import { ZBS_TEMPLATE_UNUSABLE_CODES, ZbsErrorClass } from './zalo-zbs.constants';

/** Template status is re-read from Zalo at most this often while messages are being sent. */
export const TEMPLATE_RECHECK_MS = 6 * 3600 * 1000;

export interface ZbsTemplateGate {
  ready: boolean;
  /** Not ready only because Zalo couldn't be reached — nothing was sent, safe to retry. */
  retryable?: boolean;
  specs: ZbsTemplateParamSpec[];
  errorCode?: string;
  message?: string;
}

/** Which configured template a check is about. */
export interface ZbsTemplateTarget {
  /** Logical key, e.g. ORDER_CONFIRMATION or PROMOTION. */
  templateKey: string;
  templateId: string;
  mapping: Array<{ param: string }>;
  /** True when the operator attested ENABLE + params by hand (no template permission). */
  manuallyVerified: boolean;
  /** ENV variables named in operator-facing messages. */
  templateIdEnv: string;
  manualEnv: string;
}

export interface ZbsTemplateVerifyResult {
  ok: boolean;
  templateId: string;
  status?: string;
  errorCode?: string;
  description?: string;
  mapping?: { compatible: boolean; missingRequired: string[]; unknownParams: string[] };
}

/**
 * Template verification shared by every ZBS template this backend sends: GET
 * /template/info/v2, the stored result (zalo_zbs_templates) and the gate checked before each
 * send. Approval is never assumed — a template is usable only when Zalo reported ENABLE and
 * the ENV mapping matches its approved params, or the operator attested it manually.
 */
@Injectable()
export class ZbsTemplateService {
  private readonly logger = new Logger(ZbsTemplateService.name);

  constructor(
    @InjectModel(ZbsTemplateVerification.name)
    private readonly templateModel: Model<ZbsTemplateVerificationDocument>,
    private readonly client: ZbsApiClient,
    private readonly auth: ZbsAuthService,
  ) {}

  record(templateKey: string, templateId: string) {
    return this.templateModel.findOne({ templateKey, templateId }).lean().exec();
  }

  async gate(t: ZbsTemplateTarget): Promise<ZbsTemplateGate> {
    let record = await this.record(t.templateKey, t.templateId);
    const stale =
      !record?.lastCheckAt ||
      Date.now() - new Date(record.lastCheckAt).getTime() > TEMPLATE_RECHECK_MS ||
      // Never verified because Zalo was unreachable → try again on the next attempt.
      (record.status === 'UNVERIFIED' && record.lastCheckErrorClass === 'RETRYABLE');
    if (stale && !t.manuallyVerified) {
      await this.verify(t);
      record = await this.record(t.templateKey, t.templateId);
    }
    const specs: ZbsTemplateParamSpec[] = record?.status === 'ENABLE' ? (record.listParams ?? []) : [];

    if (t.manuallyVerified) return { ready: true, specs };
    if (!record || record.status === 'UNVERIFIED') {
      return {
        ready: false,
        retryable: record?.lastCheckErrorClass === 'RETRYABLE',
        specs,
        errorCode: 'TEMPLATE_NOT_VERIFIED',
        message: `Chưa xác minh được trạng thái template ${t.templateId}${record?.lastCheckErrorCode ? ` (${record.lastCheckErrorCode})` : ''} — bấm "Kiểm tra template" hoặc đặt ${t.manualEnv}`,
      };
    }
    if (record.status !== 'ENABLE') {
      return {
        ready: false,
        specs,
        errorCode: 'TEMPLATE_NOT_ENABLED',
        message: `Template ${t.templateId} đang ở trạng thái ${record.status}${record.reason ? ` (${record.reason})` : ''} — chỉ gửi khi ENABLE`,
      };
    }
    const cmp = compareMappingWithTemplate(t.mapping, specs);
    if (!cmp.compatible) {
      return {
        ready: false,
        specs,
        errorCode: 'TEMPLATE_PARAMS_MISMATCH',
        message: [
          cmp.missingRequired.length ? `thiếu tham số bắt buộc: ${cmp.missingRequired.join(', ')}` : '',
          cmp.unknownParams.length ? `tham số không có trong template: ${cmp.unknownParams.join(', ')}` : '',
        ]
          .filter(Boolean)
          .join('; '),
      };
    }
    return { ready: true, specs };
  }

  /** GET /template/info/v2 and store the result. Works while the sending flags are off so the
   * operator can verify before activation. */
  async verify(t: ZbsTemplateTarget): Promise<ZbsTemplateVerifyResult> {
    const { templateKey, templateId } = t;
    if (!templateId) return { ok: false, templateId, errorCode: 'TEMPLATE_ID_MISSING', description: `Chưa cấu hình ${t.templateIdEnv}` };
    const filter = { templateKey, templateId };
    const now = new Date();

    const recordFailure = async (errorCode: string, description: string, errorClass: ZbsErrorClass) => {
      await this.templateModel
        .updateOne(
          filter,
          {
            $setOnInsert: { status: 'UNVERIFIED', listParams: [] },
            $set: {
              lastCheckAt: now,
              lastCheckErrorCode: errorCode,
              lastCheckErrorMessage: description.slice(0, 300),
              lastCheckErrorClass: errorClass === 'UNKNOWN_OUTCOME' ? 'RETRYABLE' : errorClass,
            },
          },
          { upsert: true },
        )
        .exec()
        .catch(() => undefined);
      this.logger.warn(`ZBS: không kiểm tra được template ${templateId} (${errorCode})`);
      return { ok: false, templateId, errorCode, description };
    };

    const token = await this.auth.getAccessToken();
    if (!token.ok) return recordFailure(token.errorCode, token.description, token.errorClass);
    let res = await this.client.getTemplateInfo(token.accessToken, templateId);
    if (!res.ok && res.kind === 'TOKEN_INVALID') {
      const renewed = await this.auth.handleRejectedAccessToken(token.accessToken);
      if (!renewed.ok) return recordFailure(renewed.errorCode, renewed.description, renewed.errorClass);
      res = await this.client.getTemplateInfo(renewed.accessToken, templateId);
    }
    if (!res.ok) {
      // A definitive "this template is unusable" answer must close the gate; transient
      // failures keep the last known state.
      if (res.providerError !== undefined && ZBS_TEMPLATE_UNUSABLE_CODES.has(res.providerError)) {
        await this.markRejected(templateKey, templateId, res.providerError, res.description);
      }
      return recordFailure(res.errorCode, res.description, res.errorClass);
    }

    const d = res.data;
    const listParams: ZbsTemplateParamSpec[] = (d.listParams ?? [])
      .filter((p) => p && typeof p.name === 'string')
      .map((p) => ({
        name: String(p.name),
        require: p.require !== false,
        type: p.type,
        maxLength: toInt(p.maxLength),
        minLength: toInt(p.minLength),
        acceptNull: p.acceptNull,
      }));
    const status = String(d.status ?? 'UNKNOWN');
    await this.templateModel
      .updateOne(
        filter,
        {
          $set: {
            status,
            reason: d.reason,
            templateName: d.templateName,
            templateTag: d.templateTag,
            templateQuality: d.templateQuality ?? undefined,
            listParams,
            buttonCount: Array.isArray(d.listButtons) ? d.listButtons.length : 0,
            priceSdt: toInt(d.price_sdt ?? d.price),
            previewUrl: d.previewUrl,
            verifiedAt: now,
            lastCheckAt: now,
          },
          $unset: { lastCheckErrorCode: 1, lastCheckErrorMessage: 1, lastCheckErrorClass: 1 },
        },
        { upsert: true },
      )
      .exec();
    const mapping = compareMappingWithTemplate(t.mapping, listParams);
    this.logger.log(`ZBS: template ${templateId} = ${status}, mapping ${mapping.compatible ? 'khớp' : 'KHÔNG khớp'}`);
    return { ok: true, templateId, status, mapping };
  }

  /** -109/-117/-131 at send time: pause this template until it is re-verified. */
  async markRejected(templateKey: string, templateId: string, code: number, description: string): Promise<void> {
    await this.templateModel
      .updateOne(
        { templateKey, templateId },
        {
          $set: { status: `SEND_REJECTED_${code}`, reason: description.slice(0, 300), lastCheckAt: new Date() },
          $setOnInsert: { listParams: [] },
        },
        { upsert: true },
      )
      .exec()
      .catch(() => undefined);
    this.logger.error(`ZBS: Zalo từ chối template ${templateId} (${code}) — tạm dừng gửi tới khi kiểm tra lại template`);
  }

  /** Admin view of one template: stored Zalo state + the configured mapping. */
  async view(t: ZbsTemplateTarget, mappingView: Array<{ param: string; source: string }>, mappingErrors: string[]) {
    const record = t.templateId ? await this.record(t.templateKey, t.templateId) : null;
    return {
      templateKey: t.templateKey,
      templateId: t.templateId || null,
      record: record
        ? {
            status: record.status,
            reason: record.reason,
            templateName: record.templateName,
            templateTag: record.templateTag,
            templateQuality: record.templateQuality,
            listParams: record.listParams,
            buttonCount: record.buttonCount,
            priceSdt: record.priceSdt,
            previewUrl: record.previewUrl,
            verifiedAt: record.verifiedAt,
            lastCheckAt: record.lastCheckAt,
            lastCheckErrorCode: record.lastCheckErrorCode,
            lastCheckErrorMessage: record.lastCheckErrorMessage,
          }
        : null,
      mapping: mappingView,
      mappingErrors,
      comparison: record?.listParams?.length ? compareMappingWithTemplate(t.mapping, record.listParams) : null,
      manuallyVerified: t.manuallyVerified,
    };
  }
}

export function toInt(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : undefined;
}

import { useMemo, useState } from 'react';
import { Eye, X } from 'lucide-react';
import { ComposerAttachment } from '../providers/MailProvider';
import { FileTypeIcon, formatSize } from '../utils';
import { useTranslation } from 'react-i18next';
import { AttachmentPreviewModal } from './AttachmentPreviewModal';
import { getOfficeFormat, OFFICE_PREVIEW_MAX_BYTES, officeAttachmentBytes } from '../utils/officeAttachment';

export interface ComposerAttachmentPanelProps {
  readonly attachments: ComposerAttachment[];
  readonly onRemove: (index: number) => void;
}

export function ComposerAttachmentPanel({ attachments, onRemove }: ComposerAttachmentPanelProps) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<ComposerAttachment | null>(null);
  const previewProps = useMemo(() => {
    if (!preview) return null;
    const officeFormat = getOfficeFormat(preview.name, preview.contentType);
    return {
      attachment: {
        attachment_id: 'composer-preview',
        name: preview.name,
        content_type: preview.contentType,
        size: preview.size,
        is_inline: !!preview.isInline,
      },
      data: officeFormat ? null : preview.data,
      loadOffice: officeFormat ? async () => {
        if (preview.size > OFFICE_PREVIEW_MAX_BYTES) throw new Error('office-size-limit');
        return officeAttachmentBytes(preview.data);
      } : undefined,
    };
  }, [preview]);
  if (attachments.length === 0) return null;
  return (
    <>
      <div className="mail-attachments">
        {attachments.map((att, idx) => (
          <div key={idx} className="mail-view-att-card" title={att.name}>
            <div className="mail-view-att-card__icon">
              <FileTypeIcon name={att.name} size={20} />
            </div>
            <div className="mail-view-att-card__info">
              <span className="mail-view-att-card__name">{att.name}</span>
              <span className="mail-view-att-card__size">{formatSize(att.size)}</span>
            </div>
            <div className="mail-view-att-card__actions">
              {(att.contentType.startsWith('image/') || att.contentType.includes('pdf') || att.name.toLowerCase().endsWith('.pdf') || getOfficeFormat(att.name, att.contentType)) && (
                <button type="button" className="mail-view-att-card__btn" onClick={() => setPreview(att)} title={t('mail.attachment.preview')} aria-label={t('mail.attachment.preview')}>
                  <Eye size={14} />
                  <span className="mail-view-att-card__action-label">{t('mail.attachment.preview')}</span>
                </button>
              )}
              <button type="button" className="mail-view-att-card__btn" onClick={() => onRemove(idx)} title={t('eventModal.delete')} aria-label={t('eventModal.delete')}>
                <X size={14} />
                <span className="mail-view-att-card__action-label">{t('eventModal.delete')}</span>
              </button>
            </div>
          </div>
        ))}
      </div>
      {preview && attachments.includes(preview) && previewProps && (
        <AttachmentPreviewModal {...previewProps} loading={false} onClose={() => setPreview(null)} />
      )}
    </>
  );
}

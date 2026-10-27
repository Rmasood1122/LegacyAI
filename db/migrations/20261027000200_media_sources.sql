-- migrate:up

-- Voice and scanned documents (features 7 and 25; docs/phase4/09-batch-c-prepared.md): a document may now be made from
-- a recording (WAV, MP3, OGG, WebM or MP4 audio) or from a photo or scan of a page (PNG, JPEG). The AI service turns it
-- into text with its media reader - by default a reader that refuses, until a speech or text-recognition model is
-- chosen (Gate 2) - and the text then goes through redaction, chunking, consent and labels like any document. The file
-- itself is never kept, as for every document; only its type is recorded here.
ALTER TABLE sources DROP CONSTRAINT sources_mime_check;
ALTER TABLE sources ADD CONSTRAINT sources_mime_check CHECK (mime IS NULL OR mime IN (
  'application/pdf', 'text/plain', 'text/markdown',
  'audio/wav', 'audio/mpeg', 'audio/ogg', 'audio/webm', 'audio/mp4',
  'image/png', 'image/jpeg'));

-- migrate:down
-- Documents made from a recording or an image keep their passages; only their file type is forgotten, because the
-- earlier rule cannot hold it.
UPDATE sources SET mime = NULL
 WHERE mime IN ('audio/wav', 'audio/mpeg', 'audio/ogg', 'audio/webm', 'audio/mp4', 'image/png', 'image/jpeg');
ALTER TABLE sources DROP CONSTRAINT sources_mime_check;
ALTER TABLE sources ADD CONSTRAINT sources_mime_check CHECK (mime IS NULL OR mime IN ('application/pdf', 'text/plain', 'text/markdown'));

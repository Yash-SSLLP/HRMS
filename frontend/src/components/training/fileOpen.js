/**
 * Open or download one of a training's files. A PDF or picture opens in a new
 * tab (read it, print it, save it from there); anything else downloads.
 */
import { toast } from 'react-toastify';
import { downloadFile, openProtectedPdf } from '../../api/download';
import { isImageFile, isPdfFile } from './trainingUtil';

export async function openTrainingFile(trainingId, file) {
  const url = `/training/${trainingId}/files/${file._id}`;
  try {
    if (isPdfFile(file) || isImageFile(file)) await openProtectedPdf(url, 'Could not open the file');
    else await downloadFile(`${url}?download=1`, file.name);
  } catch (err) {
    toast.error(err.message || 'Could not open the file');
  }
}

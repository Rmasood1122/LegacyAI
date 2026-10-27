// What the application shows when the API cannot be reached: the reason, and the copy kept on this device if it may
// still be opened (feature 9, decision D42).
import { Banner, formatDate, Loading, Page } from '../../ui/index.tsx';
import { useOpenedPack } from './hooks.ts';
import { OfflineReader } from './OfflineReader.tsx';

export function OfflineFallback({ message }: { message: string }) {
  const { opened } = useOpenedPack();
  return (
    <main id="main">
      <Banner tone="danger" title="LegacyAI could not be reached">{message} Reload the page to try again.</Banner>
      {opened === undefined && <Loading what="the copy on this device" />}
      {opened?.state === 'expired' && (
        <Banner tone="info" title="The copy on this device has expired">It could be opened until {formatDate(opened.expiresAt)} and has been removed. Take a new copy when you are connected.</Banner>
      )}
      {opened?.state === 'clock_behind' && (
        <Banner tone="warning" title="This device's clock is behind">
          The copy was last opened on {formatDate(opened.notBefore)}, later than this device&apos;s clock says. Set the clock right to open it.
        </Banner>
      )}
      {opened?.state === 'unreadable' && <Banner tone="warning" title="The copy on this device could not be opened">It has been removed.</Banner>}
      {opened?.state === 'open' && (
        <Page title="Offline reading" intro="LegacyAI is not connected. This is the copy kept on this device; asking questions and making changes need a connection.">
          <OfflineReader opened={opened} />
        </Page>
      )}
    </main>
  );
}

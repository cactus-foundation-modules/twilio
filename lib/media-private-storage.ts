// Contribution to the core.media-private-storage extension point.
//
// Saved copies of call recordings and voicemails live in this folder with no
// media library row - see lib/recording-archive.ts. Declaring it tells core's
// storage check they are kept outside the library on purpose, so nothing offers
// to adopt them into the library or delete them as leftovers.
//
// A bare literal, and deliberately not imported from recording-archive.ts:
// everything contributed to an extension point is statically imported by the
// generated public map, and that file drags in the database and the Twilio
// client.
export const twilioPrivateStorage: readonly string[] = ['twilio']

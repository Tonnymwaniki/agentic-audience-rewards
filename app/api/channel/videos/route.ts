import { NextRequest, NextResponse } from 'next/server'
import { fetchChannelVideos, type ChannelVideo } from '@/lib/youtube-channel'

export async function GET(request: NextRequest) {
  const channel = request.nextUrl.searchParams.get('channel')

  if (!channel || !channel.trim()) {
    return NextResponse.json(
      { error: 'Missing channel parameter. Provide a YouTube channel URL, handle, or channel ID.' },
      { status: 400 }
    )
  }

  try {
    const videos = await fetchChannelVideos(channel.trim())

    if (!videos || videos.length === 0) {
      return NextResponse.json(
        { error: 'No videos found for this channel.' },
        { status: 404 }
      )
    }

    return NextResponse.json({ videos } satisfies { videos: ChannelVideo[] })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'

    if (message.includes('API error')) {
      const statusMatch = message.match(/API error: (\d+)/)
      const apiStatus = statusMatch ? parseInt(statusMatch[1], 10) : 502

      if (apiStatus === 403) {
        return NextResponse.json(
          { error: 'YouTube API quota exceeded or API key invalid. Please try again later.' },
          { status: 503 }
        )
      }

      if (apiStatus === 400) {
        return NextResponse.json(
          { error: 'Invalid request to YouTube API. Check the channel URL and try again.' },
          { status: 400 }
        )
      }

      return NextResponse.json(
        { error: `YouTube API error: ${message}` },
        { status: apiStatus }
      )
    }

    if (message.includes('Channel not found') || message.includes('Invalid YouTube channel URL')) {
      return NextResponse.json(
        { error: 'Channel not found. Please check the URL or handle and try again.' },
        { status: 404 }
      )
    }

    if (message.includes('no uploads playlist')) {
      return NextResponse.json(
        { error: 'This channel has no public videos.' },
        { status: 404 }
      )
    }

    console.error('Channel videos error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2))
    return NextResponse.json(
      { error: 'Failed to fetch channel videos. Please try again.' },
      { status: 500 }
    )
  }
}

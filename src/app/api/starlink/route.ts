import { NextResponse } from 'next/server';

export async function GET() {
  try {
    const response = await fetch('https://api.spacexdata.com/v4/starlink/query', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: {},
        options: {
          select: [
            'spaceTrack.TLE_LINE1',
            'spaceTrack.TLE_LINE2',
            'spaceTrack.OBJECT_NAME',
            'spaceTrack.INCLINATION',
            'spaceTrack.DECAYED',
            'spaceTrack.DECAY_DATE'
          ],
          pagination: false,
          limit: 100000
        }
      }),
      // Add cache headers to reduce API calls
      next: { revalidate: 300 } // Cache for 5 minutes
    });

    if (!response.ok) {
      throw new Error(`SpaceX API responded with status: ${response.status}`);
    }

    const data = await response.json();

    return NextResponse.json(data, {
      headers: {
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
      },
    });
  } catch (error) {
    console.error('Error fetching Starlink data:', error);
    return NextResponse.json(
      { error: 'Failed to fetch Starlink data' },
      { status: 500 }
    );
  }
}

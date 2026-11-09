import requests

def get_hourly_forecast(lat, lon):
    # 1. NWS requires a custom User-Agent header with your contact info/app name
    headers = {
        "User-Agent": "(weather-calendar-app, rohans69@uw.edu)"
    }

    # 2. Call the /points endpoint to get grid metadata for your coordinates
    points_url = f"https://api.weather.gov/points/{lat},{lon}"
    response = requests.get(points_url, headers=headers)
    
    if response.status_code != 200:
        print(f"Error fetching points data: {response.status_code}")
        return None

    points_data = response.json()
    
    # 3. Extract the hourly forecast URL from the properties
    hourly_url = points_data["properties"]["forecastHourly"]

    # 4. Fetch the hourly forecast data
    hourly_response = requests.get(hourly_url, headers=headers)
    
    if hourly_response.status_code != 200:
        print(f"Error fetching hourly forecast: {hourly_response.status_code}")
        return None

    return hourly_response.json()

# Example: Testing with Seattle coordinates (UW campus area roughly)
if __name__ == "__main__":
    latitude = 47.6062
    longitude = -122.3321
    
    print("Fetching NWS hourly forecast...")
    forecast_data = get_hourly_forecast(latitude, longitude)
    
    if forecast_data:
        # Print the first hourly period as a test
        first_period = forecast_data["properties"]["periods"][0]
        print(f"\nSuccess! Next Hour Forecast for {first_period['name']}:")
        print(f"Temperature: {first_period['temperature']}°{first_period['temperatureUnit']}")
        print(f"Forecast: {first_period['shortForecast']}")
        print(f"Wind: {first_period['windSpeed']} {first_period['windDirection']}")

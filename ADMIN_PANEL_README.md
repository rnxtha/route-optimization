# Route Optimization Admin Panel

A comprehensive admin dashboard for managing and monitoring your route optimization system.

## Features

### 🎯 Dashboard
- **System Information**: View total nodes, edges, graph status, and last update time
- **Performance Metrics**: Real-time statistics for the last 24 hours and 7 days
- **Quick Access**: Links to graph management and statistics pages

### 🗺️ Graph Management
- **Upload New Graph**: Upload a new OSM road graph (JSON format)
- **Graph Status**: Monitor current graph statistics and status
- **Rebuild Graph**: Reload and rebuild the graph without uploading a new file
- **Validation**: Automatic validation of uploaded graph files

### 📈 Route/Algorithm Statistics
- **Performance Comparison**: Dijkstra vs A* algorithm comparison
  - Execution time
  - Distance traveled
  - Nodes explored
  - Route calculations count
- **Trend Charts**: Visual representation of performance over time
- **Recent Routes**: Table showing last 100 route calculations with detailed metrics

## Installation

1. **Ensure migrations are applied**:
   ```bash
   python manage.py migrate routing
   ```

2. **Initialize admin panel**:
   ```bash
   python manage.py init_admin_panel
   ```

3. **Create a superuser (if not already created)**:
   ```bash
   python manage.py createsuperuser
   ```

## Usage

### Accessing the Admin Panel
1. Navigate to `/admin-panel/dashboard/` (requires admin login)
2. Log in with your Django superuser credentials
3. Browse the different sections using the sidebar

### Dashboard
The dashboard provides an at-a-glance view of your system:
- **Graph Status**: Current state of the routing graph
  - **Active**: Graph is loaded and ready for routing
  - **Loading**: Graph is being loaded
  - **Error**: There's an issue with the graph

- **Statistics Cards**: 24-hour and 7-day performance metrics
  - Total routes calculated
  - Average execution times for each algorithm
  
### Graph Management
Upload or rebuild your routing graph:

1. **Upload New Graph**:
   - Click "📤 Upload Graph"
   - Select a JSON file containing nodes and edges
   - The system will validate and load the new graph
   - Previous graph is automatically replaced

2. **Rebuild Graph**:
   - Click "🔄 Rebuild Graph" to reload the current graph
   - Useful if the graph file was modified externally

### Statistics
Monitor algorithm performance:

1. **Summary Table**: 
   - Shows count and average metrics for each algorithm over the last 7 days
   - Compares performance between Dijkstra and A*

2. **Charts**:
   - **Execution Time Trend**: Shows how execution times have changed over time
   - **Nodes Explored Trend**: Shows the number of nodes explored by each algorithm

3. **Recent Routes**:
   - Displays the last 100 route calculations
   - Sortable and filterable table with detailed metrics

## API Endpoints

### Admin Panel URLs
- `GET /admin-panel/dashboard/` - Admin dashboard
- `GET /admin-panel/graph-management/` - Graph management page
- `POST /admin-panel/graph/upload/` - Upload new graph
- `GET /admin-panel/graph/rebuild/` - Rebuild current graph
- `GET /admin-panel/statistics/` - Statistics page
- `GET /admin-panel/api/statistics/` - Get statistics JSON data

## Database Models

### GraphMetadata
Stores information about the current graph:
- `total_nodes`: Number of nodes in the graph
- `total_edges`: Number of edges in the graph
- `graph_source`: Source of the graph data (e.g., "OSM")
- `graph_region`: Geographic region (e.g., "Kathmandu")
- `file_size_mb`: Size of the graph file
- `graph_status`: Current status (active, loading, error)
- `last_updated`: Timestamp of last update

### RouteStatistic
Records statistics for each route calculation:
- `algorithm`: Algorithm used (dijkstra or astar)
- `execution_time_ms`: Execution time in milliseconds
- `distance_meters`: Route distance in meters
- `nodes_explored`: Number of nodes explored during calculation
- `path_length`: Number of nodes in the calculated path
- `start_lat/lon`, `end_lat/lon`: Coordinates of the route
- `created_at`: Timestamp of calculation

## Performance Monitoring

The statistics page shows:
- **Dijkstra Algorithm**:
  - How many routes have been calculated
  - Average execution time
  - Min/max execution times
  - Average distance and nodes explored

- **A* Algorithm**:
  - Same metrics as Dijkstra for comparison
  - Performance difference analysis

## Django Admin Interface

Both `GraphMetadata` and `RouteStatistic` models are registered in Django Admin:
- Access via `/admin/`
- View and filter statistics
- Manually edit metadata if needed

## Authentication

The admin panel requires Django admin authentication:
- Users must be logged in via `/admin/login/`
- Only superusers or staff users with appropriate permissions can access the admin panel
- All endpoints are protected with `@login_required` decorator

## File Format for Graph Upload

The JSON file must have the following structure:
```json
{
  "nodes": [
    {"id": 1, "lat": 27.7172, "lon": 85.3240},
    {"id": 2, "lat": 27.7173, "lon": 85.3241}
  ],
  "edges": [
    {
      "source": 1,
      "destination": 2,
      "distance": 100.5,
      "name": "Road Name",
      "highway": "residential",
      "oneway": false
    }
  ]
}
```

## Troubleshooting

### Admin panel not accessible
- Ensure you're logged in with a superuser account
- Check that Django admin is working correctly

### Graph upload fails
- Verify the JSON file format is correct
- Ensure file size is not too large
- Check that the file contains both "nodes" and "edges" arrays

### No statistics shown
- Route statistics are logged automatically when routes are calculated
- Run some route calculations to generate data
- Statistics may take a moment to appear in the dashboard

### Graph metadata not initialized
- Run `python manage.py init_admin_panel` to initialize metadata
- This reads the current graph and populates the GraphMetadata table

## Development

To extend the admin panel:
1. Add new fields to `GraphMetadata` or `RouteStatistic` models
2. Create new migrations: `python manage.py makemigrations routing`
3. Apply migrations: `python manage.py migrate routing`
4. Update admin panel views and templates as needed
